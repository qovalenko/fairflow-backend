import { createHash } from 'node:crypto';
import { RpcException } from '@nestjs/microservices';
import { status } from '@grpc/grpc-js';
import { of, throwError } from 'rxjs';
import { GW_METADATA } from '@fairflow/shared';
import { GatewayApiKeyValidationService } from './gateway-api-key-validation.service';

const API_KEY = 'ak_test_gateway_key';

function validMetadata(apiKey = API_KEY) {
  return {
    get: (key: string) => {
      const map: Record<string, string[]> = {
        [GW_METADATA.SERVICE_API_KEY]: [apiKey],
        [GW_METADATA.REQUEST_ID]: ['req-1'],
        [GW_METADATA.TRACE_ID]: ['trace-1'],
        [GW_METADATA.GATEWAY_ISSUED_AT]: ['1700000000000'],
        [GW_METADATA.ACTOR_TYPE]: ['service'],
      };
      return map[key] ?? [];
    },
  } as never;
}

function makeService(validateFn: jest.Mock) {
  const authClient = {
    getService: jest.fn(() => ({ validateServiceApiKey: validateFn })),
  };
  const svc = new GatewayApiKeyValidationService(authClient as never);
  svc.onModuleInit();
  return { svc, validateFn };
}

describe('GatewayApiKeyValidationService', () => {
  it('rejects calls without x-service-api-key', async () => {
    const { svc } = makeService(jest.fn());
    await expect(svc.assertValidGatewayCall({ get: () => [] } as never)).rejects.toMatchObject({
      error: { code: status.UNAUTHENTICATED, message: 'Missing x-service-api-key' },
    });
  });

  it('accepts an active key from auth and validates propagated metadata', async () => {
    const validateFn = jest.fn(() => of({ active: true }));
    const { svc } = makeService(validateFn);

    await expect(svc.assertValidGatewayCall(validMetadata())).resolves.toBeUndefined();
    expect(validateFn).toHaveBeenCalledWith({ api_key: API_KEY });
  });

  it('rejects an inactive key from auth', async () => {
    const validateFn = jest.fn(() => of({ active: false }));
    const { svc } = makeService(validateFn);

    await expect(svc.assertValidGatewayCall(validMetadata())).rejects.toMatchObject({
      error: { code: status.UNAUTHENTICATED, message: 'Invalid gateway service API key' },
    });
  });

  it('uses a fresh cache hit for a previously rejected key without calling auth again', async () => {
    const validateFn = jest.fn(() => of({ active: false }));
    const { svc } = makeService(validateFn);
    const meta = validMetadata();

    await expect(svc.assertValidGatewayCall(meta)).rejects.toBeInstanceOf(RpcException);
    validateFn.mockClear();
    await expect(svc.assertValidGatewayCall(meta)).rejects.toMatchObject({
      error: { code: status.UNAUTHENTICATED },
    });
    expect(validateFn).not.toHaveBeenCalled();
  });

  it('fail-opens on transport error when a positive entry is within stale grace', async () => {
    const validateFn = jest
      .fn()
      .mockReturnValueOnce(of({ active: true }))
      .mockReturnValueOnce(throwError(() => new Error('auth down')));
    const { svc } = makeService(validateFn);
    const meta = validMetadata();

    await svc.assertValidGatewayCall(meta);
    const cacheKey = createHash('sha256').update(API_KEY).digest('hex');
    const entry = (svc as unknown as { cache: Map<string, { exp: number; staleUntil?: number }> }).cache.get(
      cacheKey,
    );
    expect(entry).toBeDefined();
    entry!.exp = Date.now() - 1;

    await expect(svc.assertValidGatewayCall(meta)).resolves.toBeUndefined();
    expect(validateFn).toHaveBeenCalledTimes(2);
  });

  it('surfaces UNAVAILABLE when auth is down and there is no stale positive cache', async () => {
    const validateFn = jest.fn(() => throwError(() => new Error('connection refused')));
    const { svc } = makeService(validateFn);

    await expect(svc.assertValidGatewayCall(validMetadata())).rejects.toMatchObject({
      error: {
        code: status.UNAVAILABLE,
        message: expect.stringContaining('Auth service unavailable'),
      },
    });
  });

  it('rejects valid keys when propagated gateway metadata is incomplete', async () => {
    const validateFn = jest.fn(() => of({ active: true }));
    const { svc } = makeService(validateFn);
    const meta = {
      get: (key: string) => (key === GW_METADATA.SERVICE_API_KEY ? [API_KEY] : []),
    } as never;

    await expect(svc.assertValidGatewayCall(meta)).rejects.toMatchObject({
      error: { code: status.UNAUTHENTICATED, message: 'Missing x-request-id' },
    });
  });
});
