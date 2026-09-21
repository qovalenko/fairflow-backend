import { ChatStreamService, type ChatFrame } from './chat-stream.service';
import { RedisPubSubService } from './redis-pubsub.service';

describe('ChatStreamService last-seen (FR-CHAT-250)', () => {
  const redis = {
    publish: jest.fn(),
    subscribe: jest.fn(() => () => undefined),
    setEx: jest.fn(async () => undefined),
    setPersist: jest.fn(async () => undefined),
    get: jest.fn(async () => null),
    del: jest.fn(async () => undefined),
    redisEnabled: true,
  };

  const service = new ChatStreamService(redis as unknown as RedisPubSubService);

  it('writes lastseen on heartbeat', async () => {
    await service.heartbeatPresence('u1');
    expect(redis.setEx).toHaveBeenCalledWith('chat:presence:u1', '1', expect.any(Number));
    expect(redis.setPersist).toHaveBeenCalledWith(
      'chat:lastseen:u1',
      expect.stringMatching(/^\d+$/),
    );
  });

  it('returns lastSeenAt for offline users from chat:lastseen key', async () => {
    const ts = '1700000000000';
    (redis.get as jest.Mock).mockImplementation(async (key: string) => {
      if (key === 'chat:presence:u1') return null;
      if (key === 'chat:lastseen:u1') return ts;
      return null;
    });
    const presence = await service.readPresence(['u1']);
    expect(presence).toEqual([{ userId: 'u1', online: false, lastSeenAt: 1700000000000 }]);
  });

  it('publishes conversation and badge frames through Redis channels', () => {
    service.publishToConversation('c-1', {
      type: 'message',
      conversationId: 'c-1',
      message: { id: 'm-1' },
    });
    service.publishBadge('u1', { type: 'badge', userId: 'u1', unread: 2 });

    expect(redis.publish).toHaveBeenCalledWith(
      'chat:conv:c-1',
      expect.objectContaining({ type: 'message' }),
    );
    expect(redis.publish).toHaveBeenCalledWith(
      'chat:badge:u1',
      expect.objectContaining({ type: 'badge', unread: 2 }),
    );
  });

  it('delivers parsed frames to subscribers and ignores malformed payloads', () => {
    let convHandler: ((msg: string) => void) | undefined;
    (redis.subscribe as jest.Mock).mockImplementation((_ch: string, cb: (msg: string) => void) => {
      convHandler = cb;
      return () => undefined;
    });
    const seen: ChatFrame[] = [];
    service.subscribeConversation('c-1', (frame) => seen.push(frame));
    convHandler?.(JSON.stringify({ type: 'typing', conversationId: 'c-1', userId: 'u1' }));
    convHandler?.('not-json');

    expect(seen).toEqual([{ type: 'typing', conversationId: 'c-1', userId: 'u1' }]);
  });

  it('sets and clears open-state keys for notification suppression', async () => {
    await service.setOpenState('u1', 'c-1', true);
    expect(redis.setEx).toHaveBeenCalledWith('chat:open:u1:c-1', '1', expect.any(Number));

    await service.setOpenState('u1', 'c-1', false);
    expect(redis.del).toHaveBeenCalledWith('chat:open:u1:c-1');
  });
});
