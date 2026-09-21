import {
  LocalAesSecretProvider,
  SecretProviderRegistry,
  type SecretProvider,
} from './secret-provider';
import { encryptSecret, isEncryptedSecret } from './secret-crypto';

/**
 * P2.d — secret-provider abstraction. Verifies the local AES provider is a
 * behaviour-preserving wrapper over `secret-crypto`, that legacy `ConnectionDoc`
 * shapes still reveal, and that unknown ref schemes fail closed.
 */
describe('SecretProvider (P2.d)', () => {
  const KEY_ENV = 'AUTOMATION_SECRET_KEY';
  let prevKey: string | undefined;

  beforeAll(() => {
    prevKey = process.env[KEY_ENV];
    // Deterministic, >=16 chars so the local provider is available.
    process.env[KEY_ENV] = 'unit-test-secret-key-p2d';
  });

  afterAll(() => {
    if (prevKey === undefined) delete process.env[KEY_ENV];
    else process.env[KEY_ENV] = prevKey;
  });

  const makeRegistry = (extra: SecretProvider[] = []): SecretProviderRegistry => {
    const local = new LocalAesSecretProvider();
    return new SecretProviderRegistry([local, ...extra]);
  };

  describe('LocalAesSecretProvider', () => {
    it('round-trips seal -> reveal', async () => {
      const provider = new LocalAesSecretProvider();
      const plaintext = 'super-secret-signing-token';
      const sealed = await provider.seal(plaintext);

      // Stored shape is byte-for-byte the pre-existing one: enc:<id> + AES envelope.
      expect(sealed.secretRef).toMatch(/^enc:/);
      expect(isEncryptedSecret(sealed.secretEnc)).toBe(true);

      const revealed = await provider.reveal({
        secret_ref: sealed.secretRef,
        secret_enc: sealed.secretEnc,
      });
      expect(revealed).toBe(plaintext);
    });

    it('is available only when the key is configured', () => {
      const provider = new LocalAesSecretProvider();
      expect(provider.isAvailable()).toBe(true);
    });
  });

  describe('SecretProviderRegistry.reveal', () => {
    it('reveals a current (enc: ref) connection doc', async () => {
      const registry = makeRegistry();
      const sealed = await registry.sealer().seal('rotate-me');
      const revealed = await registry.reveal({
        secret_ref: sealed.secretRef,
        secret_enc: sealed.secretEnc,
      });
      expect(revealed).toBe('rotate-me');
    });

    it('reveals a LEGACY doc (envelope in secret_enc, no scheme in ref)', async () => {
      const registry = makeRegistry();
      const envelope = encryptSecret('legacy-plaintext');
      // Legacy opaque ref without a "<scheme>:" prefix must route to the local default.
      const revealed = await registry.reveal({ secret_ref: 'legacyid', secret_enc: envelope });
      expect(revealed).toBe('legacy-plaintext');

      // ...and a legacy doc with NO ref at all also routes to local.
      expect(await registry.reveal({ secret_enc: envelope })).toBe('legacy-plaintext');
    });

    it('returns "" for a legacy non-envelope secret_enc (unchanged fallback)', async () => {
      const registry = makeRegistry();
      expect(await registry.reveal({ secret_enc: 'plain-old-string' })).toBe('');
      expect(await registry.reveal({})).toBe('');
    });
  });

  describe('SecretProviderRegistry.resolve (fail-closed)', () => {
    it('defaults to local for no ref / legacy opaque ref', () => {
      const registry = makeRegistry();
      expect(registry.resolve(undefined).scheme).toBe('enc');
      expect(registry.resolve('legacyid').scheme).toBe('enc');
      expect(registry.resolve('enc:abc123').scheme).toBe('enc');
    });

    it('throws for an UNKNOWN scheme instead of silently falling back', () => {
      const registry = makeRegistry();
      expect(() => registry.resolve('kms:arn:aws:...')).toThrow(/secret provider not configured/);
    });

    it('routes to a registered custom provider without registry edits', () => {
      const kms: SecretProvider = {
        scheme: 'kms',
        isAvailable: () => true,
        seal: async () => ({ secretRef: 'kms:x' }),
        reveal: async () => 'from-kms',
      };
      const registry = makeRegistry([kms]);
      expect(registry.resolve('kms:x').scheme).toBe('kms');
    });
  });
});
