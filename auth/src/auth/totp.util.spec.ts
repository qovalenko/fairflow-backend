import { assert2faKeyConfigured, decryptSecret, encryptSecret } from './totp.util';

/**
 * TODO-019: outside development/test the AUTH_2FA_KEY is mandatory — the service
 * must refuse to boot rather than fall back to the publicly-known dev key for
 * at-rest encryption of TOTP secrets.
 */
describe('assert2faKeyConfigured (AUTH_2FA_KEY fail-closed, TODO-019)', () => {
  const savedEnv = process.env.NODE_ENV;
  const savedKey = process.env.AUTH_2FA_KEY;

  afterEach(() => {
    process.env.NODE_ENV = savedEnv;
    if (savedKey === undefined) delete process.env.AUTH_2FA_KEY;
    else process.env.AUTH_2FA_KEY = savedKey;
  });

  it('throws when AUTH_2FA_KEY is empty and NODE_ENV=production', () => {
    process.env.NODE_ENV = 'production';
    delete process.env.AUTH_2FA_KEY;
    expect(() => assert2faKeyConfigured()).toThrow(/AUTH_2FA_KEY/);
  });

  it('throws when AUTH_2FA_KEY is whitespace-only in production', () => {
    process.env.NODE_ENV = 'production';
    process.env.AUTH_2FA_KEY = '   ';
    expect(() => assert2faKeyConfigured()).toThrow(/AUTH_2FA_KEY/);
  });

  it('accepts production when AUTH_2FA_KEY is set', () => {
    process.env.NODE_ENV = 'production';
    process.env.AUTH_2FA_KEY = 'a-strong-operator-supplied-key';
    expect(() => assert2faKeyConfigured()).not.toThrow();
  });

  it('allows the dev fallback only in development/test', () => {
    process.env.NODE_ENV = 'development';
    delete process.env.AUTH_2FA_KEY;
    expect(() => assert2faKeyConfigured()).not.toThrow();
    process.env.NODE_ENV = 'test';
    expect(() => assert2faKeyConfigured()).not.toThrow();
  });

  it('encrypt/decrypt round-trips with the operator key', () => {
    process.env.NODE_ENV = 'production';
    process.env.AUTH_2FA_KEY = 'a-strong-operator-supplied-key';
    const blob = encryptSecret('JBSWY3DPEHPK3PXP');
    expect(decryptSecret(blob)).toBe('JBSWY3DPEHPK3PXP');
  });
});
