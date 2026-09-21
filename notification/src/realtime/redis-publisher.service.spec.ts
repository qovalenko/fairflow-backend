import { RedisPublisherService } from './redis-publisher.service';
import { NotificationSignalService } from './notification-signal.service';

describe('RedisPublisherService (no REDIS_URL → no-op)', () => {
  const prev = process.env.REDIS_URL;
  afterAll(() => {
    if (prev === undefined) delete process.env.REDIS_URL;
    else process.env.REDIS_URL = prev;
  });

  it('stays a no-op (redisEnabled=false) and never throws when REDIS_URL is unset', async () => {
    delete process.env.REDIS_URL;
    const svc = new RedisPublisherService();
    await svc.onModuleInit();
    expect(svc.redisEnabled).toBe(false);
    // publish must be a silent no-op, not a throw.
    expect(() => svc.publish('notif:user:u1', { type: 'badge', projectId: 'p1' })).not.toThrow();
    await expect(svc.onModuleDestroy()).resolves.toBeUndefined();
  });

  it('NotificationSignalService emits the gateway-compatible badge frame on notif:user:{id}', () => {
    const published: Array<{ channel: string; payload: unknown }> = [];
    const fakeRedis = {
      publish: (channel: string, payload: unknown) => published.push({ channel, payload }),
    } as unknown as RedisPublisherService;
    const signal = new NotificationSignalService(fakeRedis);

    signal.publishBadge('user-42', 'proj-7');
    signal.publishBadge('user-42', 'proj-7', 0);
    signal.publishBadge('', 'proj-7'); // empty user → dropped

    expect(published).toHaveLength(2);
    expect(published[0]).toEqual({
      channel: 'notif:user:user-42',
      payload: { type: 'badge', projectId: 'proj-7' },
    });
    expect(published[1]).toEqual({
      channel: 'notif:user:user-42',
      payload: { type: 'badge', projectId: 'proj-7', unread: 0 },
    });
  });

  it('publishes JSON when redis transport is wired', () => {
    const publish = jest.fn().mockResolvedValue(1);
    const quit = jest.fn().mockResolvedValue('OK');
    const svc = new RedisPublisherService();
    (svc as unknown as { pub: { publish: typeof publish; quit: typeof quit; on: jest.Mock } }).pub =
      {
        publish,
        quit,
        on: jest.fn(),
      };
    svc.publish('notif:user:u1', { type: 'badge', projectId: 'p1' });
    expect(publish).toHaveBeenCalledWith(
      'notif:user:u1',
      JSON.stringify({ type: 'badge', projectId: 'p1' }),
    );
    expect(svc.redisEnabled).toBe(true);
  });

  it('logs publish failures without throwing', async () => {
    const publish = jest.fn().mockRejectedValue(new Error('redis down'));
    const svc = new RedisPublisherService();
    (svc as unknown as { pub: { publish: typeof publish; quit: jest.Mock; on: jest.Mock } }).pub = {
      publish,
      quit: jest.fn().mockResolvedValue('OK'),
      on: jest.fn(),
    };
    expect(() => svc.publish('notif:user:u1', 'raw')).not.toThrow();
    await new Promise((resolve) => setImmediate(resolve));
    expect(publish).toHaveBeenCalledWith('notif:user:u1', 'raw');
  });
});
