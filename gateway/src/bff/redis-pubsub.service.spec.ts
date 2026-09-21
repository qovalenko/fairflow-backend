import { RedisPubSubService } from './redis-pubsub.service';

describe('RedisPubSubService (in-process fallback)', () => {
  const config = { redisUrl: '' };

  it('uses in-process bus when REDIS_URL is empty', async () => {
    const svc = new RedisPubSubService(config as never);
    await svc.onModuleInit();
    expect(svc.redisEnabled).toBe(false);

    const seen: string[] = [];
    svc.subscribe('chan', (m) => seen.push(m));
    svc.publish('chan', { hello: 'world' });
    expect(seen).toEqual(['{"hello":"world"}']);
  });

  it('supports string payloads without double-encoding', async () => {
    const svc = new RedisPubSubService(config as never);
    await svc.onModuleInit();
    const seen: string[] = [];
    svc.subscribe('raw', (m) => seen.push(m));
    svc.publish('raw', 'plain-text');
    expect(seen).toEqual(['plain-text']);
  });

  it('unsubscribe stops delivery', async () => {
    const svc = new RedisPubSubService(config as never);
    await svc.onModuleInit();
    const seen: string[] = [];
    const off = svc.subscribe('chan', (m) => seen.push(m));
    off();
    svc.publish('chan', 'x');
    expect(seen).toEqual([]);
  });

  it('KV helpers are no-ops without Redis', async () => {
    const svc = new RedisPubSubService(config as never);
    await svc.onModuleInit();
    await svc.setEx('k', 'v', 60);
    await svc.setPersist('k2', 'v2');
    await svc.del('k');
    await expect(svc.get('k')).resolves.toBeNull();
  });

  it('flushes channels subscribed before Redis connects', async () => {
    const subscribe = jest.fn().mockResolvedValue(1);
    const duplicate = jest.fn();
    const pub = {
      publish: jest.fn().mockResolvedValue(1),
      on: jest.fn(),
      duplicate,
      set: jest.fn().mockResolvedValue('OK'),
      get: jest.fn().mockResolvedValue(null),
      del: jest.fn().mockResolvedValue(1),
      quit: jest.fn().mockResolvedValue(undefined),
    };
    duplicate.mockReturnValue({
      subscribe,
      on: jest.fn(),
      quit: jest.fn().mockResolvedValue(undefined),
    });

    const dynamicImport = jest.fn().mockResolvedValue({
      default: jest.fn().mockImplementation(() => pub),
    });
    const originalFunction = globalThis.Function;
    globalThis.Function = function () {
      return dynamicImport;
    } as never;

    const svc = new RedisPubSubService({ redisUrl: 'redis://localhost:6379' } as never);
    const seen: string[] = [];
    svc.subscribe('early-chan', (m) => seen.push(m));
    await svc.onModuleInit();
    svc.publish('early-chan', { ok: true });

    expect(subscribe).toHaveBeenCalledWith('early-chan');
    expect(seen).toEqual(['{"ok":true}']);
    expect(svc.redisEnabled).toBe(true);

    globalThis.Function = originalFunction;
  });

  it('persists ephemeral keys when Redis transport is wired', async () => {
    const store = new Map<string, string>();
    const pub = {
      publish: jest.fn(),
      on: jest.fn(),
      duplicate: jest.fn(),
      set: jest.fn(async (key: string, value: string) => {
        store.set(key, value);
        return 'OK';
      }),
      get: jest.fn(async (key: string) => store.get(key) ?? null),
      del: jest.fn(async (key: string) => {
        store.delete(key);
        return 1;
      }),
      quit: jest.fn().mockResolvedValue(undefined),
      subscribe: jest.fn(),
    };
    pub.duplicate.mockReturnValue({
      subscribe: jest.fn().mockResolvedValue(1),
      on: jest.fn(),
      quit: jest.fn().mockResolvedValue(undefined),
    });

    const svc = new RedisPubSubService({ redisUrl: 'redis://localhost:6379' } as never);
    (svc as unknown as { pub: unknown }).pub = pub;
    (svc as unknown as { sub: unknown }).sub = pub.duplicate();

    const payload = JSON.stringify({ count: 2, resetAt: Date.now() + 60_000 });
    await svc.setEx('counter', payload, 60);
    await expect(svc.get('counter')).resolves.toBe(payload);
    await svc.del('counter');
    await expect(svc.get('counter')).resolves.toBeNull();
    expect(pub.del).toHaveBeenCalledWith('counter');
  });
});
