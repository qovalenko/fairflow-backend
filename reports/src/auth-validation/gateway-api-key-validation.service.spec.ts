import { RpcException } from '@nestjs/microservices';
import { status } from '@grpc/grpc-js';
import { Metadata } from '@grpc/grpc-js';
import { of, throwError } from 'rxjs';
import { GW_METADATA } from '@fairflow/shared';
import { GatewayApiKeyValidationService } from './gateway-api-key-validation.service';

function validMetadata(apiKey = 'ak_test_key', over: Partial<Record<string, string>> = {}): Metadata {
  const m = new Metadata();
  const fields: Record<string, string> = {
    [GW_METADATA.SERVICE_API_KEY]: apiKey,
    [GW_METADATA.REQUEST_ID]: 'req-1',
    [GW_METADATA.TRACE_ID]: 'trace-1',
    [GW_METADATA.GATEWAY_ISSUED_AT]: '2026-08-01T00:00:00.000Z',
    [GW_METADATA.ACTOR_TYPE]: 'service',
    ...over,
  };
  for (const [k, v] of Object.entries(fields)) m.set(k, v);
  return m;
}

function makeService(validate: jest.Mock) {
  const authClient = { getService: () => ({ validateServiceApiKey: validate }) };
  const svc = new GatewayApiKeyValidationService(authClient as never);
  svc.onModuleInit();
  return svc;
}

describe('GatewayApiKeyValidationService.assertValidGatewayCall', () => {
  it('401 при отсутствии x-service-api-key', async () => {
    const svc = makeService(jest.fn());
    const md = new Metadata();
    md.set(GW_METADATA.REQUEST_ID, 'req-1');

    await expect(svc.assertValidGatewayCall(md)).rejects.toMatchObject({
      error: { code: status.UNAUTHENTICATED, message: 'Missing x-service-api-key' },
    });
  });

  it('пропускает валидный ключ после ответа auth active=true', async () => {
    const validate = jest.fn(() => of({ active: true }));
    const svc = makeService(validate);

    await expect(svc.assertValidGatewayCall(validMetadata())).resolves.toBeUndefined();
    expect(validate).toHaveBeenCalledWith({ api_key: 'ak_test_key' });
  });

  it('401 при active=false от auth', async () => {
    const svc = makeService(jest.fn(() => of({ active: false })));

    await expect(svc.assertValidGatewayCall(validMetadata())).rejects.toMatchObject({
      error: { code: status.UNAUTHENTICATED, message: 'Invalid gateway service API key' },
    });
  });

  it('кэширует отрицательное решение без повторного вызова auth', async () => {
    const validate = jest.fn(() => of({ active: false }));
    const svc = makeService(validate);
    const md = validMetadata();

    await expect(svc.assertValidGatewayCall(md)).rejects.toBeInstanceOf(RpcException);
    await expect(svc.assertValidGatewayCall(md)).rejects.toBeInstanceOf(RpcException);
    expect(validate).toHaveBeenCalledTimes(1);
  });

  it('fail-open на stale positive при недоступности auth', async () => {
    jest.useFakeTimers();
    const validate = jest
      .fn()
      .mockReturnValueOnce(of({ active: true }))
      .mockReturnValueOnce(throwError(() => new Error('auth down')));
    const svc = makeService(validate);
    const md = validMetadata('ak_stale');

    await expect(svc.assertValidGatewayCall(md)).resolves.toBeUndefined();
    jest.advanceTimersByTime(61_000);
    await expect(svc.assertValidGatewayCall(md)).resolves.toBeUndefined();
    expect(validate).toHaveBeenCalledTimes(2);
    jest.useRealTimers();
  });

  it('UNAVAILABLE если auth недоступен и нет stale positive', async () => {
    const svc = makeService(jest.fn(() => throwError(() => new Error('auth down'))));

    await expect(svc.assertValidGatewayCall(validMetadata('ak_new'))).rejects.toMatchObject({
      error: {
        code: status.UNAVAILABLE,
        message: expect.stringContaining('Auth service unavailable'),
      },
    });
  });

  it('401 если propagated metadata неполная (нет x-request-id)', async () => {
    const validate = jest.fn(() => of({ active: true }));
    const svc = makeService(validate);
    const md = validMetadata();
    md.set(GW_METADATA.REQUEST_ID, '');

    await expect(svc.assertValidGatewayCall(md)).rejects.toMatchObject({
      error: { code: status.UNAUTHENTICATED, message: 'Missing x-request-id' },
    });
  });
});
