import { status } from '@grpc/grpc-js';
import { Metadata } from '@grpc/grpc-js';
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

describe('GatewayApiKeyValidationService', () => {
  const validateServiceApiKey = jest.fn();
  let svc: GatewayApiKeyValidationService;

  beforeEach(() => {
    validateServiceApiKey.mockReset();
    const authClient = {
      getService: jest.fn(() => ({ validateServiceApiKey })),
    };
    svc = new GatewayApiKeyValidationService(authClient as never);
    svc.onModuleInit();
  });

  it('отклоняет вызов без x-service-api-key', async () => {
    await expect(svc.assertValidGatewayCall(new Metadata())).rejects.toMatchObject({
      error: { code: status.UNAUTHENTICATED, message: 'Missing x-service-api-key' },
    });
    expect(validateServiceApiKey).not.toHaveBeenCalled();
  });

  it('отклоняет неактивный ключ после ответа auth', async () => {
    validateServiceApiKey.mockReturnValue(of({ active: false }));
    await expect(svc.assertValidGatewayCall(validMeta())).rejects.toMatchObject({
      error: { code: status.UNAUTHENTICATED, message: 'Invalid gateway service API key' },
    });
  });

  it('принимает активный ключ и проверяет propagated metadata', async () => {
    validateServiceApiKey.mockReturnValue(of({ active: true }));
    await expect(svc.assertValidGatewayCall(validMeta())).resolves.toBeUndefined();
    expect(validateServiceApiKey).toHaveBeenCalledWith({ api_key: 'ak_test_key' });
  });

  it('использует свежий кэш без повторного вызова auth', async () => {
    validateServiceApiKey.mockReturnValue(of({ active: true }));
    const meta = validMeta('ak_cached');
    await svc.assertValidGatewayCall(meta);
    await svc.assertValidGatewayCall(meta);
    expect(validateServiceApiKey).toHaveBeenCalledTimes(1);
  });

  it('кэширует отрицательное решение auth', async () => {
    validateServiceApiKey.mockReturnValue(of({ active: false }));
    const meta = validMeta('ak_bad');
    await expect(svc.assertValidGatewayCall(meta)).rejects.toMatchObject({
      error: { code: status.UNAUTHENTICATED },
    });
    await expect(svc.assertValidGatewayCall(meta)).rejects.toMatchObject({
      error: { code: status.UNAUTHENTICATED },
    });
    expect(validateServiceApiKey).toHaveBeenCalledTimes(1);
  });

  it('fail-open на transport error при недавнем положительном кэше', async () => {
    validateServiceApiKey.mockReturnValue(of({ active: true }));
    const meta = validMeta('ak_stale_ok');
    await svc.assertValidGatewayCall(meta);

    validateServiceApiKey.mockReturnValue(throwError(() => new Error('auth down')));
    await expect(svc.assertValidGatewayCall(meta)).resolves.toBeUndefined();
  });

  it('UNAVAILABLE при transport error без положительного кэша', async () => {
    validateServiceApiKey.mockReturnValue(throwError(() => new Error('auth down')));
    await expect(svc.assertValidGatewayCall(validMeta('ak_new'))).rejects.toMatchObject({
      error: { code: status.UNAVAILABLE },
    });
  });

  it('отклоняет propagated metadata без x-request-id даже при валидном ключе', async () => {
    validateServiceApiKey.mockReturnValue(of({ active: true }));
    const meta = validMeta();
    meta.remove(GW_METADATA.REQUEST_ID);
    await expect(svc.assertValidGatewayCall(meta)).rejects.toMatchObject({
      error: { code: status.UNAUTHENTICATED, message: 'Missing x-request-id' },
    });
  });

  it('не смешивает решения по разным ключам', async () => {
    validateServiceApiKey.mockImplementation(({ api_key }: { api_key: string }) =>
      of({ active: api_key === 'ak_one' }),
    );
    await svc.assertValidGatewayCall(validMeta('ak_one'));
    await expect(svc.assertValidGatewayCall(validMeta('ak_two'))).rejects.toMatchObject({
      error: { code: status.UNAUTHENTICATED },
    });
    expect(validateServiceApiKey).toHaveBeenCalledTimes(2);
  });

  it('fail-open на stale grace после истечения TTL но до staleUntil', async () => {
    const prevTtl = process.env.GATEWAY_KEY_CACHE_TTL_MS;
    const prevGrace = process.env.GATEWAY_KEY_STALE_GRACE_MS;
    process.env.GATEWAY_KEY_CACHE_TTL_MS = '1000';
    process.env.GATEWAY_KEY_STALE_GRACE_MS = '600000';

    const validateServiceApiKey = jest.fn();
    const authClient = { getService: jest.fn(() => ({ validateServiceApiKey })) };
    const staleSvc = new GatewayApiKeyValidationService(authClient as never);
    staleSvc.onModuleInit();

    validateServiceApiKey.mockReturnValue(of({ active: true }));
    const meta = validMeta('ak_stale_grace');
    await staleSvc.assertValidGatewayCall(meta);

    const nowSpy = jest.spyOn(Date, 'now');
    nowSpy.mockReturnValue(Date.now() + 2000);

    validateServiceApiKey.mockReturnValue(throwError(() => new Error('auth down')));
    await expect(staleSvc.assertValidGatewayCall(meta)).resolves.toBeUndefined();

    nowSpy.mockRestore();
    if (prevTtl === undefined) delete process.env.GATEWAY_KEY_CACHE_TTL_MS;
    else process.env.GATEWAY_KEY_CACHE_TTL_MS = prevTtl;
    if (prevGrace === undefined) delete process.env.GATEWAY_KEY_STALE_GRACE_MS;
    else process.env.GATEWAY_KEY_STALE_GRACE_MS = prevGrace;
  });

  it('evict удаляет просроченные negative-записи из кэша', async () => {
    const prevTtl = process.env.GATEWAY_KEY_CACHE_TTL_MS;
    process.env.GATEWAY_KEY_CACHE_TTL_MS = '1000';
    const validateServiceApiKey = jest.fn();
    const authClient = { getService: jest.fn(() => ({ validateServiceApiKey })) };
    const evictSvc = new GatewayApiKeyValidationService(authClient as never);
    evictSvc.onModuleInit();

    validateServiceApiKey.mockReturnValue(of({ active: false }));
    const badMeta = validMeta('ak_expired_negative');
    await expect(evictSvc.assertValidGatewayCall(badMeta)).rejects.toMatchObject({
      error: { code: status.UNAUTHENTICATED },
    });

    const nowSpy = jest.spyOn(Date, 'now');
    nowSpy.mockReturnValue(Date.now() + 5000);

    validateServiceApiKey.mockReturnValue(of({ active: true }));
    await expect(evictSvc.assertValidGatewayCall(badMeta)).resolves.toBeUndefined();
    expect(validateServiceApiKey).toHaveBeenCalledTimes(2);
    expect(validateServiceApiKey).toHaveBeenLastCalledWith({ api_key: 'ak_expired_negative' });

    nowSpy.mockRestore();
    if (prevTtl === undefined) delete process.env.GATEWAY_KEY_CACHE_TTL_MS;
    else process.env.GATEWAY_KEY_CACHE_TTL_MS = prevTtl;
  });

  it('evict удаляет просроченные записи при store', async () => {
    const prevMax = process.env.GATEWAY_KEY_CACHE_MAX;
    process.env.GATEWAY_KEY_CACHE_MAX = '1';
    validateServiceApiKey.mockImplementation(({ api_key }: { api_key: string }) =>
      of({ active: api_key.startsWith('ak_') }),
    );
    await svc.assertValidGatewayCall(validMeta('ak_first'));
    await svc.assertValidGatewayCall(validMeta('ak_second'));
    expect(validateServiceApiKey).toHaveBeenCalledTimes(2);
    if (prevMax === undefined) delete process.env.GATEWAY_KEY_CACHE_MAX;
    else process.env.GATEWAY_KEY_CACHE_MAX = prevMax;
  });
});
