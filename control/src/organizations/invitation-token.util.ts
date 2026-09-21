import { createHash, randomBytes } from 'node:crypto';

/** SHA-256 hex of the opaque invite link token (stored in DB; plaintext only in email). */
export function hashInvitationToken(plaintext: string): string {
  return createHash('sha256').update(plaintext.trim()).digest('hex');
}

/** Mint a bearer token for the email link; only `hash` is persisted (FR-AUTH-280). */
export function mintInvitationToken(): { plaintext: string; hash: string } {
  const plaintext = randomBytes(32).toString('hex');
  return { plaintext, hash: hashInvitationToken(plaintext) };
}
