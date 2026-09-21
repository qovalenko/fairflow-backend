import { sessionDenyRedisKey, sessionDenyTtlSeconds } from '@fairflow/shared';
import { SessionDenyPushService } from './session-deny-push.service';

describe('SessionDenyPushService', () => {
  const prevRedisUrl = process.env.REDIS_URL;

  afterEach(() => {
    if (prevRedisUrl) process.env.REDIS_URL = prevRedisUrl;
    else delete process.env.REDIS_URL;
  });

  it('no-ops without REDIS_URL', async () => {
    delete process.env.REDIS_URL;
    const svc = new SessionDenyPushService();
    await expect(svc.pushDenied('jti-1', new Date(Date.now() + 60_000))).resolves.toBeUndefined();
  });

  it('ignores blank jti without touching Redis', async () => {
    process.env.REDIS_URL = 'redis://127.0.0.1:6379';
    const setex = jest.fn();
    const svc = new SessionDenyPushService();
    (svc as unknown as { client: { setex: jest.Mock } }).client = { setex };
    await svc.pushDenied('  ', new Date(Date.now() + 60_000));
    expect(setex).not.toHaveBeenCalled();
  });

  it('writes deny reason to Redis with TTL derived from session expiry', async () => {
    process.env.REDIS_URL = 'redis://127.0.0.1:6379';
    const expiresAt = new Date(Date.now() + 120_000);
    const setex = jest.fn().mockResolvedValue('OK');
    const svc = new SessionDenyPushService();
    (svc as unknown as { client: { setex: jest.Mock } }).client = { setex };

    await svc.pushDenied('sess-42', expiresAt, 'password_changed');

    expect(setex).toHaveBeenCalledWith(
      sessionDenyRedisKey('sess-42'),
      sessionDenyTtlSeconds(expiresAt),
      'password_changed',
    );
  });

  it('swallows Redis setex failures (best-effort push)', async () => {
    process.env.REDIS_URL = 'redis://127.0.0.1:6379';
    const setex = jest.fn().mockRejectedValue(new Error('redis down'));
    const svc = new SessionDenyPushService();
    (svc as unknown as { client: { setex: jest.Mock } }).client = { setex };

    await expect(svc.pushDenied('sess-99', new Date(Date.now() + 60_000))).resolves.toBeUndefined();
  });

  it('pushDeniedMany skips rows without tokenId and forwards the rest', async () => {
    process.env.REDIS_URL = 'redis://127.0.0.1:6379';
    const setex = jest.fn().mockResolvedValue('OK');
    const svc = new SessionDenyPushService();
    (svc as unknown as { client: { setex: jest.Mock } }).client = { setex };

    await svc.pushDeniedMany(
      [
        { tokenId: null, expiresAt: null },
        { tokenId: 'a', expiresAt: new Date(Date.now() + 10_000) },
        { tokenId: 'b', expiresAt: new Date(Date.now() + 20_000) },
      ],
      'session_revoked',
    );

    expect(setex).toHaveBeenCalledTimes(2);
    expect(setex).toHaveBeenCalledWith(
      sessionDenyRedisKey('a'),
      expect.any(Number),
      'session_revoked',
    );
    expect(setex).toHaveBeenCalledWith(
      sessionDenyRedisKey('b'),
      expect.any(Number),
      'session_revoked',
    );
  });

  it('disconnects Redis client on module destroy', async () => {
    const disconnect = jest.fn();
    const svc = new SessionDenyPushService();
    (svc as unknown as { client: { disconnect: jest.Mock } }).client = { disconnect };

    await svc.onModuleDestroy();

    expect(disconnect).toHaveBeenCalled();
    expect((svc as unknown as { client: unknown }).client).toBeNull();
  });
});
