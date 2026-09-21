import { RpcException } from '@nestjs/microservices';
import { status } from '@grpc/grpc-js';
import { of, throwError } from 'rxjs';
import { GW_METADATA } from '@fairflow/shared';
import type { Metadata } from '@grpc/grpc-js';
import { GatewayApiKeyValidationService } from './gateway-api-key-validation.service';

const API_KEY = 'ak_test_gateway_key';

function gatewayMetadata(overrides: Partial<Record<string, string>> = {}): Metadata {
  const values: Record<string, string> = {
    [GW_METADATA.SERVICE_API_KEY]: API_KEY,
    [GW_METADATA.REQUEST_ID]: 'req-1',
    [GW_METADATA.TRACE_ID]: 'trace-abc',
    [GW_METADATA.GATEWAY_ISSUED_AT]: String(Date.now()),
    [GW_METADATA.ACTOR_TYPE]: 'service',
    ...overrides,
  };
  return {
    get: (key: string) => {
      const v = values[key];
      return v ? [v] : [];
    },
  } as Metadata;
}

function buildService(authResponse: unknown) {
  const validateServiceApiKey = jest.fn(() =>
    authResponse instanceof Error
      ? throwError(() => authResponse)
      : of(authResponse as Record<string, unknown>),
  );
  const authClient = { getService: jest.fn(() => ({ validateServiceApiKey })) };
  const svc = new GatewayApiKeyValidationService(authClient as never);
  svc.onModuleInit();
  return { svc, validateServiceApiKey };
}

describe('GatewayApiKeyValidationService', () => {
  it('rejects a call without x-service-api-key', async () => {
    const { svc } = buildService({ active: true });
    await expect(svc.assertValidGatewayCall(undefined)).rejects.toMatchObject({
      error: { code: status.UNAUTHENTICATED, message: 'Missing x-service-api-key' },
    });
  });

  it('accepts an active key from auth and validates propagated metadata', async () => {
    const { svc, validateServiceApiKey } = buildService({ active: true });
    await expect(svc.assertValidGatewayCall(gatewayMetadata())).resolves.toBeUndefined();
    expect(validateServiceApiKey).toHaveBeenCalledWith({ api_key: API_KEY });
  });

  it('rejects an inactive key from auth', async () => {
    const { svc } = buildService({ active: false });
    await expect(svc.assertValidGatewayCall(gatewayMetadata())).rejects.toMatchObject({
      error: { code: status.UNAUTHENTICATED, message: 'Invalid gateway service API key' },
    });
  });

  it('uses a fresh positive cache hit without calling auth again', async () => {
    const { svc, validateServiceApiKey } = buildService({ active: true });
    await svc.assertValidGatewayCall(gatewayMetadata());
    validateServiceApiKey.mockClear();

    await expect(svc.assertValidGatewayCall(gatewayMetadata())).resolves.toBeUndefined();
    expect(validateServiceApiKey).not.toHaveBeenCalled();
  });

  it('uses a fresh negative cache hit without calling auth again', async () => {
    const { svc, validateServiceApiKey } = buildService({ active: false });
    await expect(svc.assertValidGatewayCall(gatewayMetadata())).rejects.toBeInstanceOf(RpcException);
    validateServiceApiKey.mockClear();

    await expect(svc.assertValidGatewayCall(gatewayMetadata())).rejects.toMatchObject({
      error: { code: status.UNAUTHENTICATED },
    });
    expect(validateServiceApiKey).not.toHaveBeenCalled();
  });

  it('fail-opens on transport failure when a positive entry is within stale grace', async () => {
    const { svc, validateServiceApiKey } = buildService({ active: true });
    await svc.assertValidGatewayCall(gatewayMetadata());

    validateServiceApiKey.mockImplementation(() => throwError(() => new Error('auth down')));
    const cache = (svc as unknown as { cache: Map<string, { exp: number }> }).cache;
    for (const entry of cache.values()) {
      entry.exp = Date.now() - 1;
    }

    await expect(svc.assertValidGatewayCall(gatewayMetadata())).resolves.toBeUndefined();
  });

  it('surfaces UNAVAILABLE when auth is down and there is no stale positive cache', async () => {
    const { svc } = buildService(new Error('connection refused'));
    await expect(svc.assertValidGatewayCall(gatewayMetadata())).rejects.toMatchObject({
      error: {
        code: status.UNAVAILABLE,
        message: expect.stringContaining('Auth service unavailable'),
      },
    });
  });

  it('rejects valid auth when propagated gateway metadata is incomplete', async () => {
    const { svc } = buildService({ active: true });
    const broken = gatewayMetadata({ [GW_METADATA.REQUEST_ID]: '' });
    await expect(svc.assertValidGatewayCall(broken)).rejects.toMatchObject({
      error: { code: status.UNAUTHENTICATED, message: 'Missing x-request-id' },
    });
  });

  it('requires x-user-id when actor type is user', async () => {
    const { svc } = buildService({ active: true });
    const userActor = gatewayMetadata({
      [GW_METADATA.ACTOR_TYPE]: 'user',
      [GW_METADATA.USER_ID]: '',
    });
    await expect(svc.assertValidGatewayCall(userActor)).rejects.toMatchObject({
      error: { code: status.UNAUTHENTICATED, message: 'Missing x-user-id for user actor' },
    });
  });

  it('evicts the oldest cache entry when the LRU size bound is exceeded', async () => {
    const prevMax = process.env.GATEWAY_KEY_CACHE_MAX;
    process.env.GATEWAY_KEY_CACHE_MAX = '1';
    try {
      const { svc, validateServiceApiKey } = buildService({ active: true });

      await svc.assertValidGatewayCall(gatewayMetadata({ [GW_METADATA.SERVICE_API_KEY]: 'key-a' }));
      await svc.assertValidGatewayCall(gatewayMetadata({ [GW_METADATA.SERVICE_API_KEY]: 'key-b' }));
      validateServiceApiKey.mockClear();

      await expect(
        svc.assertValidGatewayCall(gatewayMetadata({ [GW_METADATA.SERVICE_API_KEY]: 'key-a' })),
      ).resolves.toBeUndefined();
      expect(validateServiceApiKey).toHaveBeenCalledTimes(1);
    } finally {
      if (prevMax === undefined) delete process.env.GATEWAY_KEY_CACHE_MAX;
      else process.env.GATEWAY_KEY_CACHE_MAX = prevMax;
    }
  });

  it('does not stale-serve an expired negative cache entry when auth is down', async () => {
    const { svc, validateServiceApiKey } = buildService({ active: false });
    await expect(svc.assertValidGatewayCall(gatewayMetadata())).rejects.toMatchObject({
      error: { code: status.UNAUTHENTICATED },
    });

    validateServiceApiKey.mockImplementation(() => throwError(() => new Error('auth down')));
    const cache = (svc as unknown as { cache: Map<string, { exp: number; ok: boolean }> }).cache;
    for (const entry of cache.values()) {
      entry.exp = Date.now() - 1;
    }

    await expect(svc.assertValidGatewayCall(gatewayMetadata())).rejects.toMatchObject({
      error: { code: status.UNAVAILABLE },
    });
  });
});
