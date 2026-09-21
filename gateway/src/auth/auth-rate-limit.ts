import { HttpException, HttpStatus } from '@nestjs/common';

type AttemptState = { fails: number; firstFailAt: number; lockedUntil: number };

const DEFAULT_MAX_KEYS = 50_000;

/**
 * Best-effort in-memory rate limiter for gateway auth/profile endpoints.
 * Per-instance only — same trade-off as auth-domain login lockout (Redis is TO-BE).
 */
export class AuthRateLimiter {
  private readonly attempts = new Map<string, AttemptState>();

  constructor(private readonly maxKeys = DEFAULT_MAX_KEYS) {}

  /** Throw 429 when the key is locked. */
  assertNotLocked(key: string): void {
    this.sweep();
    const state = this.attempts.get(key);
    if (state && state.lockedUntil > Date.now()) {
      throw new HttpException('Too many attempts — try again later.', HttpStatus.TOO_MANY_REQUESTS);
    }
  }

  /** Record a failed attempt; locks the key once the budget is exhausted. */
  recordFailure(
    key: string,
    opts: { maxAttempts: number; lockMs: number; windowMs: number },
  ): void {
    this.sweep();
    const now = Date.now();
    let state = this.attempts.get(key);
    if (!state || now - state.firstFailAt > opts.windowMs) {
      state = { fails: 0, firstFailAt: now, lockedUntil: 0 };
    }
    state.fails += 1;
    if (state.fails >= opts.maxAttempts) state.lockedUntil = now + opts.lockMs;
    this.attempts.set(key, state);
  }

  /** Clear counters after a successful sensitive operation. */
  reset(key: string): void {
    this.attempts.delete(key);
  }

  private sweep(): void {
    const now = Date.now();
    for (const [key, state] of this.attempts) {
      if (state.lockedUntil > now) continue;
      if (now - state.firstFailAt > 15 * 60_000) this.attempts.delete(key);
    }
    if (this.attempts.size <= this.maxKeys) return;
    for (const key of [...this.attempts.keys()].slice(0, this.attempts.size - this.maxKeys)) {
      this.attempts.delete(key);
    }
  }
}

/** Shared singleton for gateway auth/profile throttles. */
export const gatewayAuthRateLimiter = new AuthRateLimiter();

export function rateLimitKeys(userId: string | undefined, ip: string, scope: string): string[] {
  // No resolvable client IP → skip the IP key entirely: a shared `ip:unknown`
  // bucket would let N failures from ANYONE lock the endpoint for EVERY user.
  const keys = ip ? [`${scope}:ip:${ip}`] : [];
  if (userId) keys.push(`${scope}:user:${userId}`);
  return keys;
}
