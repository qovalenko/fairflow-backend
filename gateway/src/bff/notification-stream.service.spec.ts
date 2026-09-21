import { NotificationStreamService } from './notification-stream.service';

describe('NotificationStreamService', () => {
  const published: Array<{ channel: string; payload: unknown }> = [];
  const listeners = new Map<string, Array<(msg: string) => void>>();

  const redis = {
    publish: jest.fn((channel: string, payload: unknown) => {
      published.push({ channel, payload });
      for (const fn of listeners.get(channel) ?? []) fn(JSON.stringify(payload));
    }),
    subscribe: jest.fn((channel: string, listener: (msg: string) => void) => {
      const arr = listeners.get(channel) ?? [];
      arr.push(listener);
      listeners.set(channel, arr);
      return () => {
        listeners.set(
          channel,
          (listeners.get(channel) ?? []).filter((x) => x !== listener),
        );
      };
    }),
  };

  beforeEach(() => {
    published.length = 0;
    listeners.clear();
    jest.clearAllMocks();
  });

  it('no-ops publishBadge for blank user id', () => {
    const svc = new NotificationStreamService(redis as never);
    svc.publishBadge('', { type: 'badge', projectId: 'p1', unread: 1 });
    expect(redis.publish).not.toHaveBeenCalled();
  });

  it('publishes badge signals on the per-user channel', () => {
    const svc = new NotificationStreamService(redis as never);
    const signal = { type: 'badge' as const, projectId: 'p1', unread: 3 };
    svc.publishBadge('u1', signal);
    expect(redis.publish).toHaveBeenCalledWith('notif:user:u1', signal);
  });

  it('delivers parsed badge signals to subscribers and ignores malformed frames', () => {
    const svc = new NotificationStreamService(redis as never);
    const seen: unknown[] = [];
    svc.subscribe('u1', (s) => seen.push(s));
    redis.publish.mockImplementationOnce((channel, payload) => {
      for (const fn of listeners.get(channel) ?? []) fn('not-json');
      for (const fn of listeners.get(channel) ?? []) fn(JSON.stringify(payload));
    });
    svc.publishBadge('u1', { type: 'badge', projectId: 'p1' });
    expect(seen).toEqual([{ type: 'badge', projectId: 'p1' }]);
  });
});
