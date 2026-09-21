import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';

/**
 * At-rest encryption for connection secrets (audit debt #24.1).
 *
 * Connection credentials (webhook signing secrets / bearer tokens) MUST NOT be
 * persisted in plaintext. We encrypt with AES-256-GCM (authenticated encryption)
 * using a key derived from `AUTOMATION_SECRET_KEY`. The scheme is fail-closed:
 * if the key is absent/too weak we refuse to store or read a secret rather than
 * silently falling back to plaintext.
 *
 * Ciphertext envelope (all base64url, dot-separated), prefixed with a version
 * tag so future rotations can be detected:
 *
 *   enc:v1:<iv>.<authTag>.<ciphertext>
 *
 * No external packages — only `node:crypto`.
 */

const ENVELOPE_PREFIX = 'enc:v1:';
const IV_BYTES = 12; // GCM recommended nonce length
const KEY_ENV = 'AUTOMATION_SECRET_KEY';

/** Marker thrown when the encryption key is missing/invalid — never plaintext. */
export class SecretKeyUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SecretKeyUnavailableError';
  }
}

/**
 * Derive a stable 32-byte key from the configured secret material. We accept an
 * arbitrary-length env string and hash it to 256 bits with SHA-256 so operators
 * can use a passphrase or a raw key; a too-short/empty value is rejected.
 */
function loadKey(): Buffer {
  const raw = (process.env[KEY_ENV] ?? '').trim();
  if (!raw) {
    throw new SecretKeyUnavailableError(
      `${KEY_ENV} is not set — refusing to store/read connection secrets (fail-closed)`,
    );
  }
  if (raw.length < 16) {
    throw new SecretKeyUnavailableError(
      `${KEY_ENV} is too short (>=16 chars required) — refusing to store/read secrets`,
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
 * {@link SecretKeyUnavailableError} when no key is configured (fail-closed): the
 * caller must surface an error, never persist plaintext.
 */
export function encryptSecret(plaintext: string): string {
  const key = loadKey();
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return (
    ENVELOPE_PREFIX +
    [iv, authTag, ciphertext].map((b) => b.toString('base64url')).join('.')
  );
}

/**
 * Decrypt an envelope produced by {@link encryptSecret}. Throws
 * {@link SecretKeyUnavailableError} when no key is configured, and a generic
 * error when the envelope is malformed or authentication fails (tamper/wrong
 * key). Legacy non-envelope values are rejected here — callers decide how to
 * treat them (they should be re-encrypted on next write).
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

/** Constant-time equality for secret comparison (avoids timing side-channels). */
export function secretsEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}
