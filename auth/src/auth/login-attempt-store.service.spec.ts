import {
  assertRedisConfiguredForProduction,
  LoginAttemptStore,
} from './login-attempt-store.service';

describe('assertRedisConfiguredForProduction', () => {
  const prevEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...prevEnv };
  });

  it('allows missing REDIS_URL in test/development', () => {
    process.env.NODE_ENV = 'test';
    delete process.env.REDIS_URL;
    expect(() => assertRedisConfiguredForProduction()).not.toThrow();
  });

  it('requires REDIS_URL in production', () => {
    process.env.NODE_ENV = 'production';
    delete process.env.REDIS_URL;
    expect(() => assertRedisConfiguredForProduction()).toThrow(/REDIS_URL is required/);
  });
});

describe('LoginAttemptStore', () => {
  const store = new LoginAttemptStore();

  beforeEach(() => {
    store.resetMemoryForTests();
    delete process.env.REDIS_URL;
    (store as unknown as { client: unknown; connecting: unknown }).client = null;
    (store as unknown as { connecting: unknown }).connecting = null;
  });

  it('locks after 5 identifier failures (NFR-AUTH-040)', async () => {
    for (let i = 0; i < 5; i++) {
      await store.registerFailure('id:alice');
    }
    await expect(store.assertNotLocked(['id:alice'])).rejects.toMatchObject({
      errorCode: 'rateLimit',
    });
  });

  it('reset clears the lock', async () => {
    for (let i = 0; i < 5; i++) {
      await store.registerFailure('id:bob');
    }
    await store.reset(['id:bob']);
    await expect(store.assertNotLocked(['id:bob'])).resolves.toBeUndefined();
  });

  it('ip keys use a laxer budget than identifier keys', async () => {
    for (let i = 0; i < 5; i++) {
      await store.registerFailure('ip:1.2.3.4');
    }
    await expect(store.assertNotLocked(['ip:1.2.3.4'])).resolves.toBeUndefined();
    for (let i = 0; i < 25; i++) {
      await store.registerFailure('ip:1.2.3.4');
    }
    await expect(store.assertNotLocked(['ip:1.2.3.4'])).rejects.toMatchObject({
      errorCode: 'rateLimit',
    });
  });

  it('resets failure window after LOGIN_WINDOW_MS elapsed', async () => {
    const now = Date.now();
    jest.spyOn(Date, 'now').mockReturnValue(now);
    for (let i = 0; i < 4; i++) {
      await store.registerFailure('id:carol');
    }
    jest.spyOn(Date, 'now').mockReturnValue(now + 16 * 60_000);
    await store.registerFailure('id:carol');
    await expect(store.assertNotLocked(['id:carol'])).resolves.toBeUndefined();
    jest.restoreAllMocks();
  });

  it('assertNotLocked passes when no keys are locked', async () => {
    await expect(store.assertNotLocked(['id:free', 'ip:9.9.9.9'])).resolves.toBeUndefined();
  });

  it('uses Redis when client is available', async () => {
    process.env.REDIS_URL = 'redis://127.0.0.1:6379';
    const redisStore = new Map<string, string>();
    const client = {
      get: jest.fn(async (key: string) => redisStore.get(key) ?? null),
      set: jest.fn(async (key: string, value: string) => {
        redisStore.set(key, value);
      }),
      del: jest.fn(async (key: string) => {
        redisStore.delete(key);
        return 1;
      }),
      on: jest.fn(),
    };
    (store as unknown as { client: typeof client }).client = client;

    for (let i = 0; i < 5; i++) {
      await store.registerFailure('id:redis-user');
    }
    await expect(store.assertNotLocked(['id:redis-user'])).rejects.toMatchObject({
      errorCode: 'rateLimit',
    });
    await store.reset(['id:redis-user']);
    await expect(store.assertNotLocked(['id:redis-user'])).resolves.toBeUndefined();
    expect(client.del).toHaveBeenCalledWith('auth:login-attempt:id:redis-user');
  });

  it('treats corrupt Redis JSON as empty state', async () => {
    process.env.REDIS_URL = 'redis://127.0.0.1:6379';
    const client = {
      get: jest.fn().mockResolvedValue('{not-json'),
      set: jest.fn(),
      del: jest.fn(),
      on: jest.fn(),
    };
    (store as unknown as { client: typeof client }).client = client;
    await expect(store.assertNotLocked(['id:broken'])).resolves.toBeUndefined();
  });
});
