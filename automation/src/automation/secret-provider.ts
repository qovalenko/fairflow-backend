import { Inject, Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { newEntityId } from '@fairflow/shared';
import {
  decryptSecret,
  encryptSecret,
  isEncryptedSecret,
  isSecretKeyConfigured,
} from './secret-crypto';

/**
 * Secret-provider abstraction (P2.d — audit #24.1 follow-up).
 *
 * Connection credentials must never be persisted in plaintext. Historically the
 * only backend was a local AES-256-GCM envelope keyed off `AUTOMATION_SECRET_KEY`
 * (see {@link ./secret-crypto}). This layer generalises that so a future external
 * KMS can be plugged in WITHOUT touching call-sites: a stored connection carries
 * an opaque `secret_ref` whose `<scheme>:` prefix selects the provider that can
 * seal / reveal it.
 *
 * The local provider keeps the exact on-disk shape it always had — the envelope
 * lives in `secret_enc` and `secret_ref` is a local opaque `enc:<id>` marker —
 * so existing `ConnectionDoc`s keep working with no data migration.
 */

/** DI multi-token: every registered {@link SecretProvider} is collected here. */
export const SECRET_PROVIDERS = 'AUTOMATION_SECRET_PROVIDERS';

/** Scheme of the built-in local AES provider (also the default / legacy backend). */
export const LOCAL_SECRET_SCHEME = 'enc';

/** Result of sealing a plaintext secret for at-rest storage. */
export interface SealedSecret {
  /** Opaque reference persisted as `ConnectionDoc.secret_ref` (`<scheme>:...`). */
  secretRef: string;
  /**
   * At-rest ciphertext for backends that keep the material in our own store
   * (local AES). External KMS backends resolve purely by `secretRef` and leave
   * this undefined.
   */
  secretEnc?: string;
}

/** Minimal at-rest view of a connection needed to reveal its secret. */
export interface SecretRef {
  secret_ref?: string;
  secret_enc?: string;
}

/**
 * A pluggable at-rest secret backend. Implementations MUST be fail-closed: never
 * return or persist plaintext when the backend is unavailable.
 */
export interface SecretProvider {
  /** Ref prefix this provider owns (the token before the first ':' in `secret_ref`). */
  readonly scheme: string;
  /** True when the backend is configured well enough to seal/reveal. */
  isAvailable(): boolean;
  /** Encrypt/store a plaintext secret, returning the ref (+ optional ciphertext). */
  seal(plaintext: string): Promise<SealedSecret>;
  /** Recover the plaintext secret for a stored connection. */
  reveal(ref: SecretRef): Promise<string>;
}

/**
 * Default provider: the current AES-256-GCM local envelope. Wraps
 * {@link ./secret-crypto} verbatim so behaviour and stored bytes are unchanged.
 */
@Injectable()
export class LocalAesSecretProvider implements SecretProvider, OnModuleInit {
  private readonly logger = new Logger(LocalAesSecretProvider.name);
  readonly scheme = LOCAL_SECRET_SCHEME;

  onModuleInit(): void {
    // Surface the missing key at STARTUP (TODO-020) — otherwise the operator
    // only learns about it from the first failing createConnection.
    if (!this.isAvailable()) {
      this.logger.warn(
        'AUTOMATION_SECRET_KEY is not configured (or too short) — connection secrets cannot be stored; ' +
          'CreateConnection/UpdateConnection with a secret will fail with SECRET_ENCRYPTION_UNAVAILABLE (fail-closed)',
      );
    }
  }

  isAvailable(): boolean {
    return isSecretKeyConfigured();
  }

  async seal(plaintext: string): Promise<SealedSecret> {
    // Byte-for-byte the pre-existing shape: local opaque ref + AES envelope.
    // `encryptSecret` is fail-closed (throws when no key is configured).
    const secretEnc = encryptSecret(plaintext);
    return { secretRef: `${LOCAL_SECRET_SCHEME}:${newEntityId()}`, secretEnc };
  }

  async reveal(ref: SecretRef): Promise<string> {
    // Legacy / non-envelope values are treated as "no signable secret" — the
    // same fallback the dispatcher has always used.
    if (!isEncryptedSecret(ref.secret_enc)) return '';
    return decryptSecret(ref.secret_enc as string);
  }
}

/**
 * Selects the {@link SecretProvider} for a given `secret_ref`. Providers are
 * injected via the {@link SECRET_PROVIDERS} multi-token, so new backends (e.g. a
 * KMS provider) register through DI without editing this class.
 *
 * Resolution:
 *  - no ref, or a ref with no `<scheme>:` prefix (legacy opaque) ⇒ local default;
 *  - a known scheme ⇒ its provider;
 *  - an UNKNOWN scheme (e.g. `kms:` with no KMS provider wired) ⇒ hard error
 *    (`secret provider not configured`) — fail-closed, never a silent fallback.
 */
@Injectable()
export class SecretProviderRegistry {
  private readonly byScheme = new Map<string, SecretProvider>();
  private readonly local: SecretProvider;

  constructor(@Inject(SECRET_PROVIDERS) providers: SecretProvider[]) {
    for (const provider of providers) {
      this.byScheme.set(provider.scheme, provider);
    }
    const local = this.byScheme.get(LOCAL_SECRET_SCHEME);
    if (!local) {
      throw new Error(
        `local secret provider (scheme='${LOCAL_SECRET_SCHEME}') is not registered`,
      );
    }
    this.local = local;
  }

  /** Provider used to seal NEW secrets (currently always the local default). */
  sealer(): SecretProvider {
    return this.local;
  }

  /** Provider that owns an existing `secret_ref`. */
  resolve(secretRef?: string): SecretProvider {
    const scheme = this.schemeOf(secretRef);
    if (!scheme) return this.local; // no ref / legacy opaque → local default
    const provider = this.byScheme.get(scheme);
    if (!provider) {
      // Explicit fail-closed: an unknown scheme must NOT quietly fall back to the
      // local key (that could mis-decrypt or expose the wrong material).
      throw new Error(`secret provider not configured for scheme '${scheme}'`);
    }
    return provider;
  }

  /** Reveal a stored secret via the provider that owns its ref. */
  reveal(ref: SecretRef): Promise<string> {
    return this.resolve(ref.secret_ref).reveal(ref);
  }

  private schemeOf(ref?: string): string | undefined {
    if (!ref) return undefined;
    const idx = ref.indexOf(':');
    // No ':' (or leading ':') ⇒ legacy opaque ref, handled by the local default.
    if (idx <= 0) return undefined;
    return ref.slice(0, idx);
  }
}
