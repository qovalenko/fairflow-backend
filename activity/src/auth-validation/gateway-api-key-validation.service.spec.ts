import { status as grpcStatus } from '@grpc/grpc-js';
import { of, throwError } from 'rxjs';
import { buildGatewayOutboundMetadata } from '@fairflow/shared';
import { GatewayApiKeyValidationService } from './gateway-api-key-validation.service';

function validMetadata(apiKey = 'ak_test_key') {
  return buildGatewayOutboundMetadata({
    serviceApiKey: apiKey,
    gatewayApiKeyId: 'gw-1',
    headers: {},
    actorType: 'service',
  });
}

function makeService(validateFn: jest.Mock) {
  const client = { getService: () => ({ validateServiceApiKey: validateFn }) } as never;
  const svc = new GatewayApiKeyValidationService(client);
  svc.onModuleInit();
  return svc;
}

async function grpcCode(fn: () => Promise<unknown>): Promise<number | undefined> {
  try {
    await fn();
    return undefined;
  } catch (err) {
    return (err as { error?: { code?: number } }).error?.code;
  }
}

describe('GatewayApiKeyValidationService (PEP)', () => {
  const prevTtl = process.env.GATEWAY_KEY_CACHE_TTL_MS;
  const prevGrace = process.env.GATEWAY_KEY_STALE_GRACE_MS;

  beforeEach(() => {
    process.env.GATEWAY_KEY_CACHE_TTL_MS = '60000';
    process.env.GATEWAY_KEY_STALE_GRACE_MS = '600000';
  });

  afterAll(() => {
    if (prevTtl === undefined) delete process.env.GATEWAY_KEY_CACHE_TTL_MS;
    else process.env.GATEWAY_KEY_CACHE_TTL_MS = prevTtl;
    if (prevGrace === undefined) delete process.env.GATEWAY_KEY_STALE_GRACE_MS;
    else process.env.GATEWAY_KEY_STALE_GRACE_MS = prevGrace;
  });

  it('rejects missing x-service-api-key', async () => {
    const validate = jest.fn();
    const svc = makeService(validate);
    expect(await grpcCode(() => svc.assertValidGatewayCall(validMetadata('')))).toBe(
      grpcStatus.UNAUTHENTICATED,
    );
    expect(validate).not.toHaveBeenCalled();
  });

  it('rejects inactive keys from auth', async () => {
    const validate = jest.fn(() => of({ active: false }));
    const svc = makeService(validate);
    expect(await grpcCode(() => svc.assertValidGatewayCall(validMetadata()))).toBe(
      grpcStatus.UNAUTHENTICATED,
    );
  });

  it('accepts active keys with propagated gateway metadata', async () => {
    const validate = jest.fn(() => of({ active: true }));
    const svc = makeService(validate);
    await expect(svc.assertValidGatewayCall(validMetadata())).resolves.toBeUndefined();
    expect(validate).toHaveBeenCalledWith({ api_key: 'ak_test_key' });
  });

  it('caches a positive decision (one auth call within TTL)', async () => {
    const validate = jest.fn(() => of({ active: true }));
    const svc = makeService(validate);
    const meta = validMetadata('ak_cached');
    await svc.assertValidGatewayCall(meta);
    await svc.assertValidGatewayCall(meta);
    expect(validate).toHaveBeenCalledTimes(1);
  });

  it('caches a negative decision without re-querying auth', async () => {
    const validate = jest.fn(() => of({ active: false }));
    const svc = makeService(validate);
    const meta = validMetadata('ak_bad');
    expect(await grpcCode(() => svc.assertValidGatewayCall(meta))).toBe(grpcStatus.UNAUTHENTICATED);
    expect(await grpcCode(() => svc.assertValidGatewayCall(meta))).toBe(grpcStatus.UNAUTHENTICATED);
    expect(validate).toHaveBeenCalledTimes(1);
  });

  it('fail-opens on transport errors when a positive cache entry is still within stale grace', async () => {
    const validate = jest
      .fn()
      .mockReturnValueOnce(of({ active: true }))
      .mockReturnValueOnce(throwError(() => new Error('auth down')));
    const svc = makeService(validate);
    const meta = validMetadata('ak_stale_ok');
    const t0 = 1_000_000;
    const nowSpy = jest.spyOn(Date, 'now').mockReturnValue(t0);
    await svc.assertValidGatewayCall(meta);
    nowSpy.mockReturnValue(t0 + 120_000);
    await expect(svc.assertValidGatewayCall(meta)).resolves.toBeUndefined();
    expect(validate).toHaveBeenCalledTimes(2);
    nowSpy.mockRestore();
  });

  it('surfaces UNAVAILABLE when auth is down and there is no stale positive cache', async () => {
    const validate = jest.fn(() => throwError(() => new Error('auth down')));
    const svc = makeService(validate);
    expect(await grpcCode(() => svc.assertValidGatewayCall(validMetadata('ak_new')))).toBe(
      grpcStatus.UNAVAILABLE,
    );
  });

  it('rejects valid keys when propagated metadata is incomplete', async () => {
    const validate = jest.fn(() => of({ active: true }));
    const svc = makeService(validate);
    const meta = validMetadata();
    meta.remove('x-request-id');
    expect(await grpcCode(() => svc.assertValidGatewayCall(meta))).toBe(grpcStatus.UNAUTHENTICATED);
  });
});
