import {
  sessionDenyRedisKey,
  sessionDenyTtlSeconds,
  SESSION_DENY_PEP_CACHE_MS,
} from './session-deny';

describe('session-deny helpers', () => {
  it('builds a stable Redis key per jti', () => {
    expect(sessionDenyRedisKey('abc')).toBe('ff:auth:session-deny:abc');
  });

  it('computes TTL from expiry with a 1s floor', () => {
    const now = Date.now();
    expect(sessionDenyTtlSeconds(new Date(now + 5000), now)).toBe(5);
    expect(sessionDenyTtlSeconds(new Date(now - 1000), now)).toBe(1);
    expect(sessionDenyTtlSeconds(null, now)).toBe(86400);
  });

  it('defines a positive PEP cache window', () => {
    expect(SESSION_DENY_PEP_CACHE_MS).toBeGreaterThan(0);
  });
});
