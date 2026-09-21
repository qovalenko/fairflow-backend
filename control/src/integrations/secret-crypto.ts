import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

/**
 * At-rest encryption for `ProjectIntegration.secret` (TODO-087).
 *
 * The integration secret is a live credential — a REST bearer/webhook signing
 * token, a DB password, a Kafka SASL password. Storing it plaintext in the
 * `control` schema means a DB dump (or any `SELECT` by an operator/backup) is a
 * credential leak; masking it on the read path only hides it from the API.
 *
 * Scheme mirrors `automation/src/automation/secret-crypto.ts` verbatim so the
 * box has ONE envelope format: AES-256-GCM (authenticated — tampering with the
 * ciphertext fails to decrypt), key derived from `FF_SECRET_ENCRYPTION_KEY`.
 *
 * Fail-closed: with no (or a too-weak) key we refuse to store or read a secret
 * rather than silently persisting plaintext.
 *
 * Envelope (base64url, dot-separated, version-tagged for future rotation):
 *
 *   enc:v1:<iv>.<authTag>.<ciphertext>
 *
 * Backwards compatibility: rows written before this change hold a bare
 * plaintext string (no `enc:v1:` prefix). {@link isEncryptedSecret} detects
 * them so the delivery path can still sign with a legacy secret; the row is
 * upgraded to an envelope on the next write (no offline migration needed).
 *
 * No external packages — only `node:crypto`.
 */

const ENVELOPE_PREFIX = 'enc:v1:';
const IV_BYTES = 12; // GCM recommended nonce length
/** Env var holding the key material (exported for log/error messages). */
export const SECRET_KEY_ENV = 'FF_SECRET_ENCRYPTION_KEY';

/** Marker thrown when the encryption key is missing/invalid — never plaintext. */
export class SecretKeyUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SecretKeyUnavailableError';
  }
}

/**
 * Derive a stable 32-byte key from the configured secret material. An
 * arbitrary-length env string is hashed to 256 bits with SHA-256 so operators
 * may use a passphrase or a raw key; a too-short/empty value is rejected.
 */
function loadKey(): Buffer {
  const raw = (process.env[SECRET_KEY_ENV] ?? '').trim();
  if (!raw) {
    throw new SecretKeyUnavailableError(
      `${SECRET_KEY_ENV} is not set — refusing to store/read integration secrets (fail-closed)`,
    );
  }
  if (raw.length < 16) {
    throw new SecretKeyUnavailableError(
      `${SECRET_KEY_ENV} is too short (>=16 chars required) — refusing to store/read secrets`,
    );
  }
  return createHash('sha256').update(raw, 'utf8').digest();
}

/** True when the encryption key is configured (used for a fail-closed guard). */
export function isSecretKeyConfigured(): boolean {
  try {
    loadKey();
    return true;
  } catch {
    return false;
  }
}

/** True when `value` is one of our encrypted envelopes (vs legacy/plaintext). */
export function isEncryptedSecret(value: string | undefined | null): boolean {
  return typeof value === 'string' && value.startsWith(ENVELOPE_PREFIX);
}

/**
 * Encrypt a plaintext secret into a versioned AES-256-GCM envelope. Throws
 * {@link SecretKeyUnavailableError} when no key is configured (fail-closed):
 * the caller must surface an error, never persist plaintext.
 */
export function encryptSecret(plaintext: string): string {
  const key = loadKey();
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return ENVELOPE_PREFIX + [iv, authTag, ciphertext].map((b) => b.toString('base64url')).join('.');
}

/**
 * Decrypt an envelope produced by {@link encryptSecret}. Throws
 * {@link SecretKeyUnavailableError} when no key is configured, and a generic
 * error when the envelope is malformed or authentication fails (tamper/wrong
 * key). Legacy non-envelope values are rejected here — callers decide how to
 * treat them (see {@link revealSecret}).
 */
export function decryptSecret(envelope: string): string {
  const key = loadKey();
  if (!isEncryptedSecret(envelope)) {
    throw new Error('Not an encrypted secret envelope');
  }
  const body = envelope.slice(ENVELOPE_PREFIX.length);
  const parts = body.split('.');
  if (parts.length !== 3) {
    throw new Error('Malformed secret envelope');
  }
  const [iv, authTag, ciphertext] = parts.map((p) => Buffer.from(p, 'base64url'));
  if (iv.length !== IV_BYTES || authTag.length !== 16) {
    throw new Error('Malformed secret envelope');
  }
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
}

/**
 * Resolve a stored column value to the usable plaintext at the single point of
 * use (webhook signing). An envelope is decrypted; a legacy plaintext row is
 * returned as-is (it predates this change and will be re-encrypted on the next
 * write).
 *
 * `null` means "no usable plaintext" and covers TWO different facts:
 *  - the column is empty — the integration has no secret at all;
 *  - the column holds a value we cannot decrypt (missing/rotated
 *    `FF_SECRET_ENCRYPTION_KEY`, DB moved between contours, tampered row).
 *
 * The caller MUST tell them apart by looking at the stored value: signing with
 * nothing is correct only in the first case. In the second the delivery has to
 * FAIL (see `WebhookDeliveryService.deliverToIntegration`) — an unsigned POST
 * would silently drop the integrity guarantee the receiver checks.
 */
export function revealSecret(stored: string | null | undefined): string | null {
  if (stored == null || stored.length === 0) return null;
  if (!isEncryptedSecret(stored)) return stored; // legacy plaintext row
  try {
    return decryptSecret(stored);
  } catch {
    return null;
  }
}
