import { Metadata } from '@grpc/grpc-js';
import { RpcException } from '@nestjs/microservices';
import { status } from '@grpc/grpc-js';
import { of, throwError } from 'rxjs';
import { GW_METADATA } from '@fairflow/shared';
import { GatewayApiKeyValidationService } from './gateway-api-key-validation.service';

function validMeta(apiKey = 'ak_test_key'): Metadata {
  const m = new Metadata();
  m.set(GW_METADATA.SERVICE_API_KEY, apiKey);
  m.set(GW_METADATA.REQUEST_ID, 'req-1');
  m.set(GW_METADATA.TRACE_ID, 'trace-1');
  m.set(GW_METADATA.GATEWAY_ISSUED_AT, String(Date.now()));
  m.set(GW_METADATA.ACTOR_TYPE, 'service');
  return m;
}

function makeService(active = true, authError?: Error) {
  const validateServiceApiKey = jest.fn(() =>
    authError ? throwError(() => authError) : of({ active }),
  );
  const authClient = { getService: () => ({ validateServiceApiKey }) };
  const svc = new GatewayApiKeyValidationService(authClient as never);
  svc.onModuleInit();
  return { svc, validateServiceApiKey };
}

describe('GatewayApiKeyValidationService', () => {
  it('rejects a call without x-service-api-key', async () => {
    const { svc } = makeService();
    const err = await svc.assertValidGatewayCall(new Metadata()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RpcException);
    expect((err as RpcException).getError()).toMatchObject({
      code: status.UNAUTHENTICATED,
      message: 'Missing x-service-api-key',
    });
  });

  it('validates an active key against auth and checks propagated metadata', async () => {
    const { svc, validateServiceApiKey } = makeService(true);
    await expect(svc.assertValidGatewayCall(validMeta())).resolves.toBeUndefined();
    expect(validateServiceApiKey).toHaveBeenCalledWith({ api_key: 'ak_test_key' });
  });

  it('rejects an inactive key returned by auth', async () => {
    const { svc } = makeService(false);
    const err = await svc.assertValidGatewayCall(validMeta()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RpcException);
    expect((err as RpcException).getError()).toMatchObject({
      code: status.UNAUTHENTICATED,
      message: 'Invalid gateway service API key',
    });
  });

  it('uses a fresh cache hit for a previously rejected key without re-calling auth', async () => {
    const { svc, validateServiceApiKey } = makeService(false);
    await svc.assertValidGatewayCall(validMeta()).catch(() => undefined);
    validateServiceApiKey.mockClear();
    const err = await svc.assertValidGatewayCall(validMeta()).catch((e: unknown) => e);
    expect(validateServiceApiKey).not.toHaveBeenCalled();
    expect((err as RpcException).getError()).toMatchObject({ code: status.UNAUTHENTICATED });
  });

  it('fail-opens on auth transport failure when a positive entry is still within stale grace', async () => {
    const { svc, validateServiceApiKey } = makeService(true);
    await svc.assertValidGatewayCall(validMeta());
    validateServiceApiKey.mockImplementation(() =>
      throwError(() => new Error('auth down')),
    );
    await expect(svc.assertValidGatewayCall(validMeta())).resolves.toBeUndefined();
  });

  it('surfaces UNAVAILABLE when auth is down and there is no positive cache entry', async () => {
    const { svc } = makeService(true, new Error('connection refused'));
    const err = await svc.assertValidGatewayCall(validMeta('ak_unknown')).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RpcException);
    expect((err as RpcException).getError()).toMatchObject({
      code: status.UNAVAILABLE,
      message: expect.stringContaining('connection refused'),
    });
  });

  it('rejects valid keys when propagated gateway metadata is incomplete', async () => {
    const { svc } = makeService(true);
    const m = new Metadata();
    m.set(GW_METADATA.SERVICE_API_KEY, 'ak_test_key');
    const err = await svc.assertValidGatewayCall(m).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RpcException);
    expect((err as RpcException).getError()).toMatchObject({ code: status.UNAUTHENTICATED });
  });
});
