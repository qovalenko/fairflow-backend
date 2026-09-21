/**
 * Purpose-scoped JWT secret. Derived from the access-token secret so one-time
 * tokens (reset, verify, MFA challenge, email change) are signed with a
 * DIFFERENT key — a leaked purpose token cannot be replayed as a session bearer.
 */
export function purposeSecret(kind: string): string {
  return `${process.env.JWT_SECRET ?? 'change-me-min-32-chars-for-production'}:${kind}`;
}
