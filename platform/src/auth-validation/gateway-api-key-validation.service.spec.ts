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
  afterEach(() => {
    jest.useRealTimers();
  });

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

  it('uses a fresh cache hit for a previously accepted key without calling auth again', async () => {
    const validateFn = jest.fn(() => of({ active: true }));
    const { svc } = makeService(validateFn);
    const meta = validMetadata();

    await svc.assertValidGatewayCall(meta);
    validateFn.mockClear();
    await expect(svc.assertValidGatewayCall(meta)).resolves.toBeUndefined();
    expect(validateFn).not.toHaveBeenCalled();
  });

  it('accepts non-string api key values from metadata via toString()', async () => {
    const validateFn = jest.fn(() => of({ active: true }));
    const { svc } = makeService(validateFn);
    const meta = {
      get: (key: string) => {
        const map: Record<string, unknown[]> = {
          [GW_METADATA.SERVICE_API_KEY]: [{ toString: () => API_KEY }],
          [GW_METADATA.REQUEST_ID]: ['req-1'],
          [GW_METADATA.TRACE_ID]: ['trace-1'],
          [GW_METADATA.GATEWAY_ISSUED_AT]: ['1700000000000'],
          [GW_METADATA.ACTOR_TYPE]: ['service'],
        };
        return map[key] ?? [];
      },
    } as never;

    await expect(svc.assertValidGatewayCall(meta)).resolves.toBeUndefined();
    expect(validateFn).toHaveBeenCalledWith({ api_key: API_KEY });
  });

  it('fail-opens on transport error when a positive entry is within stale grace', async () => {
    jest.useFakeTimers();
    const validateFn = jest
      .fn()
      .mockReturnValueOnce(of({ active: true }))
      .mockReturnValueOnce(throwError(() => new Error('auth down')));
    const { svc } = makeService(validateFn);
    const meta = validMetadata();

    await svc.assertValidGatewayCall(meta);
    jest.advanceTimersByTime(61_000);
    await expect(svc.assertValidGatewayCall(meta)).resolves.toBeUndefined();
    expect(validateFn).toHaveBeenCalledTimes(2);
    jest.useRealTimers();
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

  it('surfaces UNAVAILABLE without error detail when transport failure is not an Error', async () => {
    const validateFn = jest.fn(() => throwError(() => 'timeout'));
    const { svc } = makeService(validateFn);

    await expect(svc.assertValidGatewayCall(validMetadata())).rejects.toMatchObject({
      error: {
        code: status.UNAVAILABLE,
        message: 'Auth service unavailable for gateway key validation',
      },
    });
  });

  it('evicts least-recently-used cache entries when the size bound is exceeded', async () => {
    const prevMax = process.env.GATEWAY_KEY_CACHE_MAX;
    process.env.GATEWAY_KEY_CACHE_MAX = '2';
    try {
      const validateFn = jest.fn((req: { api_key: string }) => of({ active: true }));
      const { svc } = makeService(validateFn);

      await svc.assertValidGatewayCall(validMetadata('key-a'));
      await svc.assertValidGatewayCall(validMetadata('key-b'));
      await svc.assertValidGatewayCall(validMetadata('key-c'));

      validateFn.mockClear();
      await svc.assertValidGatewayCall(validMetadata('key-a'));
      expect(validateFn).toHaveBeenCalledWith({ api_key: 'key-a' });
    } finally {
      if (prevMax === undefined) delete process.env.GATEWAY_KEY_CACHE_MAX;
      else process.env.GATEWAY_KEY_CACHE_MAX = prevMax;
    }
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
