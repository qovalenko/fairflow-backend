import {
  encryptSecret,
  decryptSecret,
  isEncryptedSecret,
  isSecretKeyConfigured,
  revealSecret,
  SecretKeyUnavailableError,
} from './secret-crypto';

/**
 * TODO-087: `ProjectIntegration.secret` (REST token / DB password / Kafka SASL)
 * must not sit in Postgres as plaintext. These tests pin the three properties
 * the fix rests on: the envelope round-trips, it is fail-closed without a key,
 * and it is authenticated (a tampered ciphertext does not decrypt).
 */
describe('control integration secret-crypto (TODO-087)', () => {
  const KEY = 'FF_SECRET_ENCRYPTION_KEY';
  const original = process.env[KEY];

  afterEach(() => {
    if (original === undefined) delete process.env[KEY];
    else process.env[KEY] = original;
  });

  it('round-trips a secret through the versioned AES-256-GCM envelope', () => {
    process.env[KEY] = 'a-sufficiently-long-box-passphrase';
    const envelope = encryptSecret('super-secret-webhook-token');

    expect(isEncryptedSecret(envelope)).toBe(true);
    expect(envelope.startsWith('enc:v1:')).toBe(true);
    // The whole point: the plaintext must not be recoverable by reading the row.
    expect(envelope).not.toContain('super-secret-webhook-token');
    expect(decryptSecret(envelope)).toBe('super-secret-webhook-token');
  });

  it('produces a different envelope for the same plaintext (random IV)', () => {
    process.env[KEY] = 'a-sufficiently-long-box-passphrase';
    expect(encryptSecret('same')).not.toBe(encryptSecret('same'));
  });

  it('is fail-closed without a key — never falls back to plaintext', () => {
    delete process.env[KEY];
    expect(isSecretKeyConfigured()).toBe(false);
    expect(() => encryptSecret('token')).toThrow(SecretKeyUnavailableError);
    expect(() => decryptSecret('enc:v1:a.b.c')).toThrow(SecretKeyUnavailableError);
  });

  it('rejects a too-short key rather than encrypting weakly', () => {
    process.env[KEY] = 'short';
    expect(isSecretKeyConfigured()).toBe(false);
    expect(() => encryptSecret('token')).toThrow(SecretKeyUnavailableError);
  });

  it('fails authentication on a tampered ciphertext', () => {
    process.env[KEY] = 'a-sufficiently-long-box-passphrase';
    const envelope = encryptSecret('token');
    const [iv, tag, ct] = envelope.slice('enc:v1:'.length).split('.');
    // Tamper the FIRST base64url char: the last one may carry only discarded
    // padding bits (5-byte plaintext → 2 unused bits), so flipping it can
    // legally decode to the same bytes and pass GCM auth (~1/16 of runs).
    const flipped = (ct.startsWith('A') ? 'B' : 'A') + ct.slice(1);
    expect(() => decryptSecret(`enc:v1:${iv}.${tag}.${flipped}`)).toThrow();
  });

  it('does not decrypt with a different key', () => {
    process.env[KEY] = 'a-sufficiently-long-box-passphrase';
    const envelope = encryptSecret('token');
    process.env[KEY] = 'a-completely-different-passphrase';
    expect(() => decryptSecret(envelope)).toThrow();
  });

  describe('revealSecret (point of use)', () => {
    it('decrypts an envelope', () => {
      process.env[KEY] = 'a-sufficiently-long-box-passphrase';
      expect(revealSecret(encryptSecret('hmac-key'))).toBe('hmac-key');
    });

    it('passes a legacy pre-encryption plaintext row through unchanged', () => {
      // Backwards compatibility: rows written before TODO-087 hold a bare
      // string. Webhook signing must keep working until they are rewritten.
      process.env[KEY] = 'a-sufficiently-long-box-passphrase';
      expect(revealSecret('legacy-plaintext')).toBe('legacy-plaintext');
    });

    it('returns null (unsigned request) instead of leaking ciphertext', () => {
      process.env[KEY] = 'a-sufficiently-long-box-passphrase';
      const envelope = encryptSecret('hmac-key');
      delete process.env[KEY];
      expect(revealSecret(envelope)).toBeNull();
    });

    it('returns null for an absent/empty secret', () => {
      expect(revealSecret(null)).toBeNull();
      expect(revealSecret(undefined)).toBeNull();
      expect(revealSecret('')).toBeNull();
    });
  });
});
