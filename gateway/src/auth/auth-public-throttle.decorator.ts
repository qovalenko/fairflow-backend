import { SetMetadata } from '@nestjs/common';

export const AUTH_PUBLIC_THROTTLE_KEY = 'auth_public_throttle';

export type AuthPublicThrottleOptions = {
  /** Max hits within `ttlMs` per tracker key. FR-AUTH-205: ≤5/hour. */
  limit: number;
  ttlMs: number;
  /** Extract extra keys (e.g. email from body) in addition to client IP. */
  extraKeys?: (req: { body?: Record<string, unknown>; ip?: string }) => string[];
};

export const AuthPublicThrottle = (options: AuthPublicThrottleOptions) =>
  SetMetadata(AUTH_PUBLIC_THROTTLE_KEY, options);

/** FR-AUTH-205 canonical budget: 5 requests per hour per key. */
export const AUTH_PUBLIC_HOURLY_5: AuthPublicThrottleOptions = {
  limit: 5,
  ttlMs: 60 * 60_000,
};
