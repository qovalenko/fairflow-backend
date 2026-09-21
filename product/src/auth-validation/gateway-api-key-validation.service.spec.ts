import { status } from '@grpc/grpc-js';
import { Metadata } from '@grpc/grpc-js';
import { RpcException } from '@nestjs/microservices';
import { of, throwError } from 'rxjs';
import { GW_METADATA } from '@fairflow/shared';
import { GatewayApiKeyValidationService } from './gateway-api-key-validation.service';

function validMetadata(apiKey: string): Metadata {
  const m = new Metadata();
  m.set(GW_METADATA.SERVICE_API_KEY, apiKey);
  m.set(GW_METADATA.REQUEST_ID, 'req-1');
  m.set(GW_METADATA.TRACE_ID, 'trace-1');
  m.set(GW_METADATA.GATEWAY_ISSUED_AT, String(Date.now()));
  m.set(GW_METADATA.ACTOR_TYPE, 'service');
  return m;
}

function makeService(authResult: { active?: boolean } | 'error' = { active: true }) {
  const validateServiceApiKey = jest.fn(() => {
    if (authResult === 'error') return throwError(() => new Error('auth down'));
    return of(authResult);
  });
  const authClient = { getService: jest.fn(() => ({ validateServiceApiKey })) };
  const svc = new GatewayApiKeyValidationService(authClient as never);
  svc.onModuleInit();
  return { svc, validateServiceApiKey };
}

describe('GatewayApiKeyValidationService', () => {
  it('rejects calls without x-service-api-key', async () => {
    const { svc } = makeService();
    await expect(svc.assertValidGatewayCall(new Metadata())).rejects.toMatchObject({
      error: expect.objectContaining({
        code: status.UNAUTHENTICATED,
        message: 'Missing x-service-api-key',
      }),
    });
  });

  it('accepts an active key and enforces propagated gateway metadata', async () => {
    const { svc, validateServiceApiKey } = makeService({ active: true });
    await expect(svc.assertValidGatewayCall(validMetadata('ak_live'))).resolves.toBeUndefined();
    expect(validateServiceApiKey).toHaveBeenCalledWith({ api_key: 'ak_live' });
  });

  it('rejects inactive keys from auth', async () => {
    const { svc } = makeService({ active: false });
    await expect(svc.assertValidGatewayCall(validMetadata('ak_bad'))).rejects.toMatchObject({
      error: expect.objectContaining({
        code: status.UNAUTHENTICATED,
        message: 'Invalid gateway service API key',
      }),
    });
  });

  it('uses the positive cache and skips auth on a fresh hit', async () => {
    const { svc, validateServiceApiKey } = makeService({ active: true });
    const md = validMetadata('ak_cached');
    await svc.assertValidGatewayCall(md);
    validateServiceApiKey.mockClear();
    await expect(svc.assertValidGatewayCall(md)).resolves.toBeUndefined();
    expect(validateServiceApiKey).not.toHaveBeenCalled();
  });

  it('surfaces UNAVAILABLE when auth is down and there is no stale positive', async () => {
    const { svc } = makeService('error');
    await expect(svc.assertValidGatewayCall(validMetadata('ak_new'))).rejects.toMatchObject({
      error: expect.objectContaining({
        code: status.UNAVAILABLE,
        message: expect.stringContaining('Auth service unavailable'),
      }),
    });
  });

  it('fail-opens on transport errors when a positive entry is still within stale grace', async () => {
    jest.useFakeTimers();
    const prevTtl = process.env.GATEWAY_KEY_CACHE_TTL_MS;
    process.env.GATEWAY_KEY_CACHE_TTL_MS = '1000';
    const validateServiceApiKey = jest
      .fn()
      .mockReturnValueOnce(of({ active: true }))
      .mockReturnValueOnce(throwError(() => new Error('auth down')));
    const authClient = { getService: jest.fn(() => ({ validateServiceApiKey })) };
    const svc = new GatewayApiKeyValidationService(authClient as never);
    svc.onModuleInit();
    const md = validMetadata('ak_grace');
    await svc.assertValidGatewayCall(md);
    jest.advanceTimersByTime(2_000);
    await expect(svc.assertValidGatewayCall(md)).resolves.toBeUndefined();
    expect(validateServiceApiKey).toHaveBeenCalledTimes(2);
    if (prevTtl === undefined) delete process.env.GATEWAY_KEY_CACHE_TTL_MS;
    else process.env.GATEWAY_KEY_CACHE_TTL_MS = prevTtl;
    jest.useRealTimers();
  });

  it('rejects valid keys when propagated metadata is incomplete', async () => {
    const { svc } = makeService({ active: true });
    const md = new Metadata();
    md.set(GW_METADATA.SERVICE_API_KEY, 'ak_live');
    await expect(svc.assertValidGatewayCall(md)).rejects.toBeInstanceOf(RpcException);
  });
});
