import { AuthPublicThrottleGuard } from './auth-public-throttle.guard';
import { AUTH_PUBLIC_HOURLY_5 } from './auth-public-throttle.decorator';

describe('AuthPublicThrottleGuard (FR-AUTH-205)', () => {
  const reflector = {
    getAllAndOverride: jest.fn().mockReturnValue(AUTH_PUBLIC_HOURLY_5),
  };
  const redis = { redisEnabled: false, get: jest.fn(), set: jest.fn() };
  const guard = new AuthPublicThrottleGuard(reflector as never, redis as never);

  beforeEach(() => {
    guard.resetForTests();
  });

  afterEach(() => {
    delete process.env.TRUST_PROXY;
  });

  const ctx = (ip = '9.9.9.9', body: Record<string, unknown> = {}) =>
    ({
      switchToHttp: () => ({
        getRequest: () => ({ ip, body, headers: {} }),
      }),
      getHandler: () => ({}),
      getClass: () => ({}),
    }) as never;

  it('allows up to 5 hits per hour per IP', async () => {
    for (let i = 0; i < 5; i++) {
      await expect(guard.canActivate(ctx())).resolves.toBe(true);
    }
    await expect(guard.canActivate(ctx())).rejects.toMatchObject({ status: 429 });
  });

  it('passes through when route has no throttle metadata', async () => {
    const openReflector = { getAllAndOverride: jest.fn().mockReturnValue(undefined) };
    const openGuard = new AuthPublicThrottleGuard(openReflector as never, redis as never);
    await expect(openGuard.canActivate(ctx())).resolves.toBe(true);
  });

  it('tracks extra keys from decorator in addition to client IP', async () => {
    const extraReflector = {
      getAllAndOverride: jest.fn().mockReturnValue({
        limit: 1,
        ttlMs: 60_000,
        extraKeys: (req: { body?: Record<string, unknown> }) => [
          `email:${String(req.body?.email ?? '')}`,
        ],
      }),
    };
    const extraGuard = new AuthPublicThrottleGuard(extraReflector as never, redis as never);
    extraGuard.resetForTests();
    const body = { email: 'alice@t.test' };

    await expect(extraGuard.canActivate(ctx('1.1.1.1', body))).resolves.toBe(true);
    await expect(extraGuard.canActivate(ctx('1.1.1.1', body))).rejects.toMatchObject({
      status: 429,
    });
  });

  it('uses X-Forwarded-For when TRUST_PROXY is enabled', async () => {
    process.env.TRUST_PROXY = 'true';
    const proxyGuard = new AuthPublicThrottleGuard(reflector as never, redis as never);
    proxyGuard.resetForTests();
    const proxyCtx = {
      switchToHttp: () => ({
        getRequest: () => ({
          ip: '127.0.0.1',
          headers: { 'x-forwarded-for': '203.0.113.10, 10.0.0.1' },
          body: {},
        }),
      }),
      getHandler: () => ({}),
      getClass: () => ({}),
    } as never;

    for (let i = 0; i < 5; i++) {
      await expect(proxyGuard.canActivate(proxyCtx)).resolves.toBe(true);
    }
    await expect(proxyGuard.canActivate(proxyCtx)).rejects.toMatchObject({ status: 429 });
    delete process.env.TRUST_PROXY;
  });

  it('stores counters in Redis when transport is enabled', async () => {
    const store = new Map<string, string>();
    const redisEnabled = {
      redisEnabled: true,
      get: jest.fn(async (key: string) => store.get(key) ?? null),
      setEx: jest.fn(async (key: string, value: string) => {
        store.set(key, value);
      }),
    };
    const redisGuard = new AuthPublicThrottleGuard(reflector as never, redisEnabled as never);
    const ctx = {
      switchToHttp: () => ({
        getRequest: () => ({ ip: '8.8.8.8', headers: {}, body: {} }),
      }),
      getHandler: () => ({}),
      getClass: () => ({}),
    } as never;

    for (let i = 0; i < 5; i++) {
      await expect(redisGuard.canActivate(ctx)).resolves.toBe(true);
    }
    await expect(redisGuard.canActivate(ctx)).rejects.toMatchObject({ status: 429 });
    expect(redisEnabled.setEx).toHaveBeenCalled();
  });
});
