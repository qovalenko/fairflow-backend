import { HttpException } from '@nestjs/common';
import { AuthRateLimiter, rateLimitKeys } from './auth-rate-limit';

describe('rateLimitKeys', () => {
  it('skips the ip key when the client ip is unresolvable (no shared bucket)', () => {
    expect(rateLimitKeys('u1', '', 's')).toEqual(['s:user:u1']);
    expect(rateLimitKeys('u1', '1.2.3.4', 's')).toEqual(['s:ip:1.2.3.4', 's:user:u1']);
  });
});

describe('AuthRateLimiter', () => {
  it('locks a key after maxAttempts failures', () => {
    const limiter = new AuthRateLimiter();
    const opts = { maxAttempts: 3, lockMs: 60_000, windowMs: 60_000 };
    for (let i = 0; i < 3; i++) limiter.recordFailure('k1', opts);
    expect(() => limiter.assertNotLocked('k1')).toThrow(HttpException);
  });

  it('reset clears the lock', () => {
    const limiter = new AuthRateLimiter();
    const opts = { maxAttempts: 2, lockMs: 60_000, windowMs: 60_000 };
    limiter.recordFailure('k2', opts);
    limiter.recordFailure('k2', opts);
    limiter.reset('k2');
    expect(() => limiter.assertNotLocked('k2')).not.toThrow();
  });
});
