/** Redis key for a revoked session jti (gateway PEP reads, auth pushes on revoke). */
export function sessionDenyRedisKey(jti: string): string {
  return `ff:auth:session-deny:${jti.trim()}`;
}

/** Local PEP cache TTL — avoids a gRPC ValidateSession on every HTTP request (NFR-AUTH-020). */
export const SESSION_DENY_PEP_CACHE_MS = 30_000;

/** TTL for a deny-list Redis entry from session expiry (minimum 1s). */
export function sessionDenyTtlSeconds(expiresAt: Date | null | undefined, now = Date.now()): number {
  if (!expiresAt) return 86400;
  const sec = Math.ceil((expiresAt.getTime() - now) / 1000);
  return sec > 0 ? sec : 1;
}
