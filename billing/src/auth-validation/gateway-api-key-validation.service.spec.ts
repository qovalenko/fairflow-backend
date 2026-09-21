import { Metadata, status } from '@grpc/grpc-js';
import { of, throwError } from 'rxjs';
import { GW_METADATA } from '@fairflow/shared';
import { GatewayApiKeyValidationService } from './gateway-api-key-validation.service';

function validMetadata(apiKey = 'ak_test_key'): Metadata {
  const md = new Metadata();
  md.set(GW_METADATA.SERVICE_API_KEY, apiKey);
  md.set(GW_METADATA.REQUEST_ID, 'req-1');
  md.set(GW_METADATA.TRACE_ID, 'trace-1');
  md.set(GW_METADATA.GATEWAY_ISSUED_AT, String(Date.now()));
  md.set(GW_METADATA.ACTOR_TYPE, 'service');
  return md;
}

function buildService(validate: jest.Mock) {
  const authClient = {
    getService: jest.fn().mockReturnValue({ validateServiceApiKey: validate }),
  };
  const service = new GatewayApiKeyValidationService(authClient as never);
  service.onModuleInit();
  return service;
}

describe('GatewayApiKeyValidationService', () => {
  it('rejects calls without x-service-api-key', async () => {
    const service = buildService(jest.fn());
    await expect(service.assertValidGatewayCall(new Metadata())).rejects.toMatchObject({
      error: { code: status.UNAUTHENTICATED, message: 'Missing x-service-api-key' },
    });
  });

  it('accepts an active key from auth and requires propagated gateway metadata', async () => {
    const validate = jest.fn().mockReturnValue(of({ active: true }));
    const service = buildService(validate);
    await expect(service.assertValidGatewayCall(validMetadata())).resolves.toBeUndefined();
    expect(validate).toHaveBeenCalledWith({ api_key: 'ak_test_key' });
  });

  it('rejects an inactive key returned by auth', async () => {
    const validate = jest.fn().mockReturnValue(of({ active: false }));
    const service = buildService(validate);
    await expect(service.assertValidGatewayCall(validMetadata('ak_bad'))).rejects.toMatchObject({
      error: { code: status.UNAUTHENTICATED, message: 'Invalid gateway service API key' },
    });
  });

  it('rejects a cached negative decision without calling auth again', async () => {
    const validate = jest.fn().mockReturnValue(of({ active: false }));
    const service = buildService(validate);
    const md = validMetadata('ak_negative');
    await expect(service.assertValidGatewayCall(md)).rejects.toMatchObject({
      error: { code: status.UNAUTHENTICATED },
    });
    await expect(service.assertValidGatewayCall(md)).rejects.toMatchObject({
      error: { code: status.UNAUTHENTICATED },
    });
    expect(validate).toHaveBeenCalledTimes(1);
  });

  it('uses the positive cache entry without calling auth again', async () => {
    const validate = jest.fn().mockReturnValue(of({ active: true }));
    const service = buildService(validate);
    const md = validMetadata('ak_cached');
    await service.assertValidGatewayCall(md);
    await service.assertValidGatewayCall(md);
    expect(validate).toHaveBeenCalledTimes(1);
  });

  it('fail-opens on transport errors when a recent positive cache entry exists', async () => {
    const prevTtl = process.env.GATEWAY_KEY_CACHE_TTL_MS;
    const prevGrace = process.env.GATEWAY_KEY_STALE_GRACE_MS;
    process.env.GATEWAY_KEY_CACHE_TTL_MS = '1';
    process.env.GATEWAY_KEY_STALE_GRACE_MS = '600000';
    try {
      const validate = jest
        .fn()
        .mockReturnValueOnce(of({ active: true }))
        .mockReturnValueOnce(throwError(() => new Error('auth down')));
      const service = buildService(validate);
      const md = validMetadata('ak_grace');
      await service.assertValidGatewayCall(md);
      await new Promise((r) => setTimeout(r, 5));
      await expect(service.assertValidGatewayCall(md)).resolves.toBeUndefined();
      // Soft TTL must have expired so the second call re-hits auth (and then fail-opens).
      expect(validate).toHaveBeenCalledTimes(2);
    } finally {
      if (prevTtl === undefined) delete process.env.GATEWAY_KEY_CACHE_TTL_MS;
      else process.env.GATEWAY_KEY_CACHE_TTL_MS = prevTtl;
      if (prevGrace === undefined) delete process.env.GATEWAY_KEY_STALE_GRACE_MS;
      else process.env.GATEWAY_KEY_STALE_GRACE_MS = prevGrace;
    }
  });

  it('surfaces UNAVAILABLE when auth is down and there is no stale positive cache', async () => {
    const validate = jest.fn().mockReturnValue(throwError(() => new Error('auth down')));
    const service = buildService(validate);
    await expect(service.assertValidGatewayCall(validMetadata('ak_new'))).rejects.toMatchObject({
      error: {
        code: status.UNAVAILABLE,
        message: expect.stringContaining('Auth service unavailable'),
      },
    });
  });

  it('rejects propagated metadata missing x-request-id even after auth success', async () => {
    const validate = jest.fn().mockReturnValue(of({ active: true }));
    const service = buildService(validate);
    const md = new Metadata();
    md.set(GW_METADATA.SERVICE_API_KEY, 'ak_test_key');
    await expect(service.assertValidGatewayCall(md)).rejects.toMatchObject({
      error: { code: status.UNAUTHENTICATED, message: 'Missing x-request-id' },
    });
  });
});
