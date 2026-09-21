import { Metadata } from '@grpc/grpc-js';
import { status } from '@grpc/grpc-js';
import { RpcException } from '@nestjs/microservices';
import { of, throwError } from 'rxjs';
import { GW_METADATA } from '@fairflow/shared';
import { GatewayApiKeyValidationService } from './gateway-api-key-validation.service';

const API_KEY = 'ak_test_gateway_key';

function validMetadata(apiKey = API_KEY): Metadata {
  const m = new Metadata();
  m.set(GW_METADATA.SERVICE_API_KEY, apiKey);
  m.set(GW_METADATA.REQUEST_ID, 'req-1');
  m.set(GW_METADATA.TRACE_ID, 'trace-1');
  m.set(GW_METADATA.GATEWAY_ISSUED_AT, String(Date.now()));
  m.set(GW_METADATA.ACTOR_TYPE, 'service');
  return m;
}

function build(active = true, failTransport = false) {
  const validateServiceApiKey = jest.fn(() => {
    if (failTransport) return throwError(() => new Error('auth down'));
    return of({ active });
  });
  const authClient = {
    getService: () => ({ validateServiceApiKey }),
  };
  const svc = new GatewayApiKeyValidationService(authClient as never);
  svc.onModuleInit();
  return { svc, validateServiceApiKey };
}

function rpcErrorCode(err: unknown): number | undefined {
  if (err instanceof RpcException) {
    return (err.getError() as { code?: number }).code;
  }
  return undefined;
}

describe('GatewayApiKeyValidationService', () => {
  const prevTtl = process.env.GATEWAY_KEY_CACHE_TTL_MS;
  const prevGrace = process.env.GATEWAY_KEY_STALE_GRACE_MS;

  beforeEach(() => {
    process.env.GATEWAY_KEY_CACHE_TTL_MS = '60000';
    process.env.GATEWAY_KEY_STALE_GRACE_MS = '600000';
  });

  afterEach(() => {
    if (prevTtl === undefined) delete process.env.GATEWAY_KEY_CACHE_TTL_MS;
    else process.env.GATEWAY_KEY_CACHE_TTL_MS = prevTtl;
    if (prevGrace === undefined) delete process.env.GATEWAY_KEY_STALE_GRACE_MS;
    else process.env.GATEWAY_KEY_STALE_GRACE_MS = prevGrace;
  });

  it('rejects calls without x-service-api-key', async () => {
    const { svc } = build();
    await expect(svc.assertValidGatewayCall(new Metadata())).rejects.toMatchObject({
      message: expect.stringContaining('Missing x-service-api-key'),
    });
    expect(rpcErrorCode(await svc.assertValidGatewayCall(new Metadata()).catch((e) => e))).toBe(
      status.UNAUTHENTICATED,
    );
  });

  it('rejects an inactive key from auth', async () => {
    const { svc, validateServiceApiKey } = build(false);
    await expect(svc.assertValidGatewayCall(validMetadata())).rejects.toMatchObject({
      message: expect.stringContaining('Invalid gateway service API key'),
    });
    expect(validateServiceApiKey).toHaveBeenCalledWith({ api_key: API_KEY });
  });

  it('accepts an active key and validates propagated gateway metadata', async () => {
    const { svc, validateServiceApiKey } = build(true);
    await expect(svc.assertValidGatewayCall(validMetadata())).resolves.toBeUndefined();
    expect(validateServiceApiKey).toHaveBeenCalledTimes(1);
  });

  it('uses the cache on a second call within TTL (no extra auth round-trip)', async () => {
    const { svc, validateServiceApiKey } = build(true);
    await svc.assertValidGatewayCall(validMetadata());
    await svc.assertValidGatewayCall(validMetadata());
    expect(validateServiceApiKey).toHaveBeenCalledTimes(1);
  });

  it('replays a cached negative decision without calling auth again', async () => {
    const { svc, validateServiceApiKey } = build(false);
    await expect(svc.assertValidGatewayCall(validMetadata())).rejects.toBeTruthy();
    await expect(svc.assertValidGatewayCall(validMetadata())).rejects.toBeTruthy();
    expect(validateServiceApiKey).toHaveBeenCalledTimes(1);
  });

  it('fail-opens on transport error when a positive cache entry is within stale grace', async () => {
    // TTL must expire so the second call leaves the fresh-hit path and hits
    // transport + staleUntil. The sibling cache-hit test already covers TTL-fresh.
    process.env.GATEWAY_KEY_CACHE_TTL_MS = '1';
    process.env.GATEWAY_KEY_STALE_GRACE_MS = '600000';
    const { svc, validateServiceApiKey } = build(true);
    await svc.assertValidGatewayCall(validMetadata());
    validateServiceApiKey.mockImplementation(() => throwError(() => new Error('auth down')));
    await new Promise((r) => setTimeout(r, 5));
    await expect(svc.assertValidGatewayCall(validMetadata())).resolves.toBeUndefined();
    expect(validateServiceApiKey).toHaveBeenCalledTimes(2);
  });

  it('surfaces UNAVAILABLE when auth is down and there is no stale positive cache', async () => {
    const { svc } = build(true, true);
    await expect(svc.assertValidGatewayCall(validMetadata())).rejects.toMatchObject({
      message: expect.stringContaining('Auth service unavailable'),
    });
    expect(rpcErrorCode(await svc.assertValidGatewayCall(validMetadata()).catch((e) => e))).toBe(
      status.UNAVAILABLE,
    );
  });

  it('rejects propagated metadata missing x-request-id even after key validation', async () => {
    const { svc } = build(true);
    const m = validMetadata();
    m.remove(GW_METADATA.REQUEST_ID);
    await expect(svc.assertValidGatewayCall(m)).rejects.toMatchObject({
      message: expect.stringContaining('Missing x-request-id'),
    });
  });
});
