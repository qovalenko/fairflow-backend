import { Metadata, status } from '@grpc/grpc-js';
import { RpcException } from '@nestjs/microservices';
import { of, throwError } from 'rxjs';
import { GW_METADATA } from '@fairflow/shared';
import { GatewayApiKeyValidationService } from './gateway-api-key-validation.service';

function validMeta(apiKey: string): Metadata {
  const m = new Metadata();
  m.set(GW_METADATA.SERVICE_API_KEY, apiKey);
  m.set(GW_METADATA.REQUEST_ID, 'req-1');
  m.set(GW_METADATA.TRACE_ID, 'trace-1');
  m.set(GW_METADATA.GATEWAY_ISSUED_AT, String(Date.now()));
  m.set(GW_METADATA.ACTOR_TYPE, 'service');
  m.set(GW_METADATA.PROJECT_ID, 'p1');
  return m;
}

function makeService(auth: { active?: boolean } | 'down' | 'inactive') {
  const validateServiceApiKey = jest.fn(() => {
    if (auth === 'down') return throwError(() => new Error('auth unreachable'));
    return of({ active: auth === 'inactive' ? false : (auth.active ?? true) });
  });
  const authClient = { getService: () => ({ validateServiceApiKey }) };
  const svc = new GatewayApiKeyValidationService(authClient as never);
  svc.onModuleInit();
  return { svc, validateServiceApiKey };
}

describe('GatewayApiKeyValidationService', () => {
  it('rejects missing x-service-api-key', async () => {
    const { svc } = makeService({ active: true });
    await expect(svc.assertValidGatewayCall(new Metadata())).rejects.toMatchObject({
      message: expect.stringContaining('Missing x-service-api-key'),
    });
  });

  it('accepts a valid key after auth confirms active=true', async () => {
    const { svc, validateServiceApiKey } = makeService({ active: true });
    await expect(svc.assertValidGatewayCall(validMeta('ak_live'))).resolves.toBeUndefined();
    expect(validateServiceApiKey).toHaveBeenCalledWith({ api_key: 'ak_live' });
  });

  it('rejects an inactive key from auth', async () => {
    const { svc } = makeService('inactive');
    await expect(svc.assertValidGatewayCall(validMeta('ak_bad'))).rejects.toBeInstanceOf(
      RpcException,
    );
    try {
      await svc.assertValidGatewayCall(validMeta('ak_bad'));
    } catch (err) {
      expect((err as RpcException).getError()).toMatchObject({
        code: status.UNAUTHENTICATED,
        message: 'Invalid gateway service API key',
      });
    }
  });

  it('uses the cache for repeated calls without re-hitting auth', async () => {
    const { svc, validateServiceApiKey } = makeService({ active: true });
    const meta = validMeta('ak_cached');
    await svc.assertValidGatewayCall(meta);
    await svc.assertValidGatewayCall(meta);
    expect(validateServiceApiKey).toHaveBeenCalledTimes(1);
  });

  it('fail-opens on auth transport failure when a recent positive cache exists', async () => {
    const prevTtl = process.env.GATEWAY_KEY_CACHE_TTL_MS;
    const prevGrace = process.env.GATEWAY_KEY_STALE_GRACE_MS;
    process.env.GATEWAY_KEY_CACHE_TTL_MS = '50';
    process.env.GATEWAY_KEY_STALE_GRACE_MS = '600000';
    jest.useFakeTimers();
    jest.setSystemTime(1_700_000_000_000);
    try {
      const validateServiceApiKey = jest
        .fn()
        .mockReturnValueOnce(of({ active: true }))
        .mockReturnValueOnce(throwError(() => new Error('auth down')));
      const authClient = { getService: () => ({ validateServiceApiKey }) };
      const svc = new GatewayApiKeyValidationService(authClient as never);
      svc.onModuleInit();
      const meta = validMeta('ak_grace');
      await svc.assertValidGatewayCall(meta);
      expect(validateServiceApiKey).toHaveBeenCalledTimes(1);

      // Fresh TTL expired, stale grace still open — must re-hit auth and fail-open.
      jest.setSystemTime(1_700_000_000_000 + 100);
      await expect(svc.assertValidGatewayCall(meta)).resolves.toBeUndefined();
      expect(validateServiceApiKey).toHaveBeenCalledTimes(2);
    } finally {
      jest.useRealTimers();
      if (prevTtl === undefined) delete process.env.GATEWAY_KEY_CACHE_TTL_MS;
      else process.env.GATEWAY_KEY_CACHE_TTL_MS = prevTtl;
      if (prevGrace === undefined) delete process.env.GATEWAY_KEY_STALE_GRACE_MS;
      else process.env.GATEWAY_KEY_STALE_GRACE_MS = prevGrace;
    }
  });

  it('surfaces UNAVAILABLE when auth is down and there is no positive cache', async () => {
    const { svc } = makeService('down');
    await expect(svc.assertValidGatewayCall(validMeta('ak_new'))).rejects.toMatchObject({
      message: expect.stringContaining('Auth service unavailable'),
    });
    try {
      await svc.assertValidGatewayCall(validMeta('ak_new'));
    } catch (err) {
      expect((err as RpcException).getError()).toMatchObject({ code: status.UNAVAILABLE });
    }
  });

  it('rejects valid keys when propagated gateway metadata is incomplete', async () => {
    const { svc } = makeService({ active: true });
    const m = new Metadata();
    m.set(GW_METADATA.SERVICE_API_KEY, 'ak_live');
    await expect(svc.assertValidGatewayCall(m)).rejects.toMatchObject({
      message: expect.stringContaining('Missing x-request-id'),
    });
  });
});
