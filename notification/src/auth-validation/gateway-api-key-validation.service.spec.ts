import { status } from '@grpc/grpc-js';
import { Metadata } from '@grpc/grpc-js';
import { of, throwError } from 'rxjs';
import type { ClientGrpcProxy } from '@nestjs/microservices';
import { GW_METADATA } from '@fairflow/shared';
import { GatewayApiKeyValidationService } from './gateway-api-key-validation.service';

const API_KEY = 'ak_test_gateway_key';

function propagatedMetadata(apiKey = API_KEY): Metadata {
  const m = new Metadata();
  m.set(GW_METADATA.SERVICE_API_KEY, apiKey);
  m.set(GW_METADATA.REQUEST_ID, 'req-1');
  m.set(GW_METADATA.TRACE_ID, 'trace-1');
  m.set(GW_METADATA.GATEWAY_ISSUED_AT, String(Date.now()));
  m.set(GW_METADATA.ACTOR_TYPE, 'service');
  return m;
}

function makeService(
  validateServiceApiKey: jest.Mock,
  ttlMs = 60_000,
  staleGraceMs = 600_000,
): GatewayApiKeyValidationService {
  process.env.GATEWAY_KEY_CACHE_TTL_MS = String(ttlMs);
  process.env.GATEWAY_KEY_STALE_GRACE_MS = String(staleGraceMs);
  const client = {
    getService: () => ({ validateServiceApiKey }),
  } as unknown as ClientGrpcProxy;
  const svc = new GatewayApiKeyValidationService(client);
  svc.onModuleInit();
  return svc;
}

describe('GatewayApiKeyValidationService (PEP)', () => {
  afterEach(() => {
    delete process.env.GATEWAY_KEY_CACHE_TTL_MS;
    delete process.env.GATEWAY_KEY_STALE_GRACE_MS;
  });

  it('UNAUTHENTICATED when x-service-api-key is missing', async () => {
    const validate = jest.fn();
    const svc = makeService(validate);
    await expect(svc.assertValidGatewayCall(new Metadata())).rejects.toMatchObject({
      error: { code: status.UNAUTHENTICATED, message: 'Missing x-service-api-key' },
    });
    expect(validate).not.toHaveBeenCalled();
  });

  it('UNAUTHENTICATED when auth returns active=false (negative decision is cached)', async () => {
    const validate = jest.fn().mockReturnValue(of({ active: false }));
    const svc = makeService(validate);
    const md = propagatedMetadata();
    await expect(svc.assertValidGatewayCall(md)).rejects.toMatchObject({
      error: { code: status.UNAUTHENTICATED, message: 'Invalid gateway service API key' },
    });
    validate.mockClear();
    await expect(svc.assertValidGatewayCall(md)).rejects.toMatchObject({
      error: { code: status.UNAUTHENTICATED },
    });
    expect(validate).not.toHaveBeenCalled();
  });

  it('accepts a valid key and requires propagated gateway metadata', async () => {
    const validate = jest.fn().mockReturnValue(of({ active: true }));
    const svc = makeService(validate);
    const md = propagatedMetadata();
    await expect(svc.assertValidGatewayCall(md)).resolves.toBeUndefined();
    expect(validate).toHaveBeenCalledTimes(1);
    validate.mockClear();
    await expect(svc.assertValidGatewayCall(md)).resolves.toBeUndefined();
    expect(validate).not.toHaveBeenCalled();
  });

  it('UNAUTHENTICATED when propagated metadata is incomplete after a valid key', async () => {
    const validate = jest.fn().mockReturnValue(of({ active: true }));
    const svc = makeService(validate);
    const md = new Metadata();
    md.set(GW_METADATA.SERVICE_API_KEY, API_KEY);
    await expect(svc.assertValidGatewayCall(md)).rejects.toMatchObject({
      error: { code: status.UNAUTHENTICATED, message: 'Missing x-request-id' },
    });
  });

  it('fail-open on transport failure when a recent positive entry is within stale grace', async () => {
    jest.useFakeTimers();
    const validate = jest
      .fn()
      .mockReturnValueOnce(of({ active: true }))
      .mockReturnValue(throwError(() => new Error('auth down')));
    const svc = makeService(validate, 1_000, 60_000);
    const md = propagatedMetadata();
    await svc.assertValidGatewayCall(md);
    jest.advanceTimersByTime(2_000);
    await expect(svc.assertValidGatewayCall(md)).resolves.toBeUndefined();
    expect(validate).toHaveBeenCalledTimes(2);
    jest.useRealTimers();
  });

  it('UNAVAILABLE on transport failure without a stale positive cache entry', async () => {
    const validate = jest.fn().mockReturnValue(throwError(() => new Error('ECONNREFUSED')));
    const svc = makeService(validate);
    const md = propagatedMetadata();
    await expect(svc.assertValidGatewayCall(md)).rejects.toMatchObject({
      error: {
        code: status.UNAVAILABLE,
        message: expect.stringContaining('Auth service unavailable'),
      },
    });
  });
});
