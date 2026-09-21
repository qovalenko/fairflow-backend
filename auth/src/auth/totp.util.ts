import { createHmac, randomBytes, createCipheriv, createDecipheriv, scryptSync } from 'node:crypto';

/**
 * Minimal self-contained TOTP (RFC-6238) + base32 + AES-256-GCM helpers for
 * profile-module 2FA. No external dependency. Secret is encrypted at rest with
 * AUTH_2FA_KEY (NFR-MPROF-1 / OQ-MPROF-SYS-4: app-level AES-256-GCM).
 */

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function generateBase32Secret(byteLength = 20): string {
  const buf = randomBytes(byteLength);
  let bits = '';
  for (const b of buf) bits += b.toString(2).padStart(8, '0');
  let out = '';
  for (let i = 0; i + 5 <= bits.length; i += 5) {
    out += BASE32_ALPHABET[parseInt(bits.slice(i, i + 5), 2)];
  }
  return out;
}

function base32Decode(input: string): Buffer {
  const clean = input.replace(/=+$/, '').toUpperCase().replace(/\s/g, '');
  let bits = '';
  for (const ch of clean) {
    const idx = BASE32_ALPHABET.indexOf(ch);
    if (idx === -1) continue;
    bits += idx.toString(2).padStart(5, '0');
  }
  const bytes: number[] = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) {
    bytes.push(parseInt(bits.slice(i, i + 8), 2));
  }
  return Buffer.from(bytes);
}

function hotp(secret: Buffer, counter: number): string {
  const buf = Buffer.alloc(8);
  // big-endian counter
  buf.writeBigUInt64BE(BigInt(counter));
  const hmac = createHmac('sha1', secret).update(buf).digest();
  const offset = hmac[hmac.length - 1] & 0xf;
  const code =
    ((hmac[offset] & 0x7f) << 24) |
    ((hmac[offset + 1] & 0xff) << 16) |
    ((hmac[offset + 2] & 0xff) << 8) |
    (hmac[offset + 3] & 0xff);
  return (code % 1_000_000).toString().padStart(6, '0');
}

/** Current 6-digit TOTP code for the secret (RFC-6238), for the active step. */
export function generateTotp(base32Secret: string, stepSeconds = 30): string {
  const secret = base32Decode(base32Secret);
  const counter = Math.floor(Date.now() / 1000 / stepSeconds);
  return hotp(secret, counter);
}

/** Verify a 6-digit TOTP code within ±1 step (30s) of the current window. */
export function verifyTotp(base32Secret: string, code: string, stepSeconds = 30): boolean {
  const normalized = (code ?? '').replace(/\s/g, '');
  if (!/^\d{6}$/.test(normalized)) return false;
  const secret = base32Decode(base32Secret);
  const counter = Math.floor(Date.now() / 1000 / stepSeconds);
  for (let w = -1; w <= 1; w++) {
    if (hotp(secret, counter + w) === normalized) return true;
  }
  return false;
}

export function buildOtpauthUri(secret: string, account: string, issuer = 'Fairflow'): string {
  const label = encodeURIComponent(`${issuer}:${account}`);
  const params = new URLSearchParams({
    secret,
    issuer,
    algorithm: 'SHA1',
    digits: '6',
    period: '30',
  });
  return `otpauth://totp/${label}?${params.toString()}`;
}

// --- AES-256-GCM at-rest encryption for the TOTP secret ---

function keyFromEnv(): Buffer {
  const raw = (process.env.AUTH_2FA_KEY ?? '').trim();
  if (!raw) {
    const env = process.env.NODE_ENV ?? 'development';
    // Fail-closed (TODO-019): outside dev/test an operator-supplied key is
    // mandatory — otherwise every install would encrypt TOTP secrets with a key
    // derivable from the public sources.
    if (env !== 'development' && env !== 'test') {
      throw new Error(
        'AUTH_2FA_KEY is not set: it is required outside development. ' +
          '2FA TOTP secrets are encrypted at rest with this key; set a strong random value ' +
          '(rotating it later makes already-stored 2FA secrets undecryptable).',
      );
    }
  }
  // Derive a stable 32-byte key from whatever the operator supplies.
  return scryptSync(raw || 'dev-insecure-2fa-key', 'fairflow-2fa', 32);
}

/**
 * Startup guard: throws (with the message above) when AUTH_2FA_KEY is missing in a
 * non-dev environment, so the service refuses to boot instead of failing on the
 * first 2FA operation.
 */
export function assert2faKeyConfigured(): void {
  keyFromEnv();
}

export function encryptSecret(plain: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', keyFromEnv(), iv);
  const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString('base64')}:${tag.toString('base64')}:${enc.toString('base64')}`;
}

export function decryptSecret(blob: string): string {
  const [ivB64, tagB64, dataB64] = blob.split(':');
  if (!ivB64 || !tagB64 || !dataB64) throw new Error('malformed 2fa secret');
  const decipher = createDecipheriv('aes-256-gcm', keyFromEnv(), Buffer.from(ivB64, 'base64'));
  decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
  return Buffer.concat([
    decipher.update(Buffer.from(dataB64, 'base64')),
    decipher.final(),
  ]).toString('utf8');
}

/** Generate N human-friendly one-time backup codes (e.g. "abcd-1234"). */
export function generateBackupCodes(count = 10): string[] {
  const codes: string[] = [];
  for (let i = 0; i < count; i++) {
    const raw = randomBytes(5).toString('hex'); // 10 hex chars
    codes.push(`${raw.slice(0, 5)}-${raw.slice(5)}`);
  }
  return codes;
}
