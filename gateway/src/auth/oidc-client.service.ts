import { Injectable, Logger } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { createHash, randomBytes } from 'node:crypto';
import { JwksClient } from 'jwks-rsa';

/** Provider config as it arrives from auth's OidcGrpc (keepCase → snake_case). */
export interface OidcProviderWire {
  id: string;
  name: string;
  issuer: string;
  client_id: string;
  client_secret?: string;
  discovery_url?: string;
  authorization_endpoint?: string;
  token_endpoint?: string;
  user_info_endpoint?: string;
  jwks_uri?: string;
  scopes?: string[];
  trust_email?: boolean;
}

export interface OidcEndpoints {
  authorizationEndpoint: string;
  tokenEndpoint: string;
  jwksUri: string;
}

/** Per-login transient state, keyed by `state` (one-time, short TTL). */
export interface PendingOidcLogin {
  providerId: string;
  codeVerifier: string;
  nonce: string;
  redirectUrl: string;
  at: number;
}

/** Claims resolved from a VALIDATED id_token. */
export interface OidcIdentityClaims {
  subject: string;
  email: string;
  emailVerified: boolean;
  name: string;
  avatarUrl: string;
}

const STATE_TTL_MS = 10 * 60 * 1000;
const STATE_MAX = 50_000; // cap the in-memory map (unauthenticated surface — avoid memory DoS)
const DISCOVERY_TTL_MS = 10 * 60 * 1000;

/** Asymmetric signatures only. `none` and HS* (symmetric, secret = key) are forbidden. */
const ALLOWED_ID_TOKEN_ALGS = new Set([
  'RS256',
  'RS384',
  'RS512',
  'PS256',
  'PS384',
  'PS512',
  'ES256',
  'ES384',
  'ES512',
]);

/**
 * OIDC relying-party mechanics for the gateway BFF (FR-AUTH-350): PKCE (S256
 * only), state + nonce, endpoint discovery, code exchange and id_token
 * validation against the provider JWKS. The gateway is the egress point — all
 * provider HTTP happens here; auth only resolves the validated identity.
 *
 * State lives in memory (single gateway instance — same caveat as the Yandex
 * OAuth controller); each entry is one-time and expires after 10 minutes.
 */
@Injectable()
export class OidcClientService {
  private readonly logger = new Logger(OidcClientService.name);
  private readonly pending = new Map<string, PendingOidcLogin>();
  private readonly discoveryCache = new Map<string, { endpoints: OidcEndpoints; at: number }>();
  private readonly jwksClients = new Map<string, JwksClient>();

  constructor(private readonly jwt: JwtService) {}

  // --- PKCE -----------------------------------------------------------------

  /** RFC 7636: verifier 43–128 chars; challenge = BASE64URL(SHA256(verifier)). */
  static pkceChallengeS256(verifier: string): string {
    return createHash('sha256').update(verifier).digest('base64url');
  }

  // --- begin / state --------------------------------------------------------

  /**
   * Start a login: mint state + nonce + PKCE pair, remember them against the
   * `state`, and build the provider authorize URL (code flow, S256 only).
   */
  begin(
    provider: OidcProviderWire,
    endpoints: OidcEndpoints,
    callbackUrl: string,
    redirectUrl: string,
  ): { authorizeUrl: string; state: string } {
    this.sweep();
    const state = randomBytes(16).toString('hex');
    const nonce = randomBytes(16).toString('hex');
    const codeVerifier = randomBytes(32).toString('base64url'); // 43 chars
    this.pending.set(state, {
      providerId: provider.id,
      codeVerifier,
      nonce,
      redirectUrl,
      at: Date.now(),
    });
    const params = new URLSearchParams({
      response_type: 'code',
      client_id: provider.client_id,
      redirect_uri: callbackUrl,
      scope: (provider.scopes?.length ? provider.scopes : ['openid', 'profile', 'email']).join(' '),
      state,
      nonce,
      code_challenge: OidcClientService.pkceChallengeS256(codeVerifier),
      code_challenge_method: 'S256',
    });
    const sep = endpoints.authorizationEndpoint.includes('?') ? '&' : '?';
    return { authorizeUrl: `${endpoints.authorizationEndpoint}${sep}${params.toString()}`, state };
  }

  /** One-time state consumption: unknown, reused or expired → undefined. */
  consumeState(state: string | undefined): PendingOidcLogin | undefined {
    if (!state) return undefined;
    const entry = this.pending.get(state);
    if (entry) this.pending.delete(state);
    if (!entry || Date.now() - entry.at > STATE_TTL_MS) return undefined;
    return entry;
  }

  private sweep() {
    const cutoff = Date.now() - STATE_TTL_MS;
    for (const [k, v] of this.pending) if (v.at < cutoff) this.pending.delete(k);
    // hard cap: evict oldest first (Map preserves insertion order)
    while (this.pending.size >= STATE_MAX) {
      const oldest = this.pending.keys().next().value as string | undefined;
      if (!oldest) break;
      this.pending.delete(oldest);
    }
  }

  // --- discovery ------------------------------------------------------------

  /**
   * Resolve authorize/token/jwks endpoints: explicit config first, otherwise
   * OIDC discovery (`discovery_url` or `<issuer>/.well-known/openid-configuration`).
   * The discovery document's `issuer` must equal the configured issuer
   * (OIDC Discovery §4.3 — prevents IdP mix-up).
   */
  async resolveEndpoints(provider: OidcProviderWire): Promise<OidcEndpoints> {
    const explicit: Partial<OidcEndpoints> = {
      authorizationEndpoint: provider.authorization_endpoint || undefined,
      tokenEndpoint: provider.token_endpoint || undefined,
      jwksUri: provider.jwks_uri || undefined,
    };
    if (explicit.authorizationEndpoint && explicit.tokenEndpoint && explicit.jwksUri) {
      return explicit as OidcEndpoints;
    }

    const cached = this.discoveryCache.get(provider.id);
    if (cached && Date.now() - cached.at < DISCOVERY_TTL_MS) return cached.endpoints;

    const url =
      (provider.discovery_url || '').trim() ||
      `${provider.issuer.replace(/\/+$/, '')}/.well-known/openid-configuration`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`oidc discovery failed (${res.status})`);
    const doc = (await res.json()) as {
      issuer?: string;
      authorization_endpoint?: string;
      token_endpoint?: string;
      jwks_uri?: string;
    };
    if ((doc.issuer ?? '').replace(/\/+$/, '') !== provider.issuer.replace(/\/+$/, '')) {
      throw new Error('oidc discovery issuer mismatch');
    }
    const endpoints: OidcEndpoints = {
      authorizationEndpoint: explicit.authorizationEndpoint || doc.authorization_endpoint || '',
      tokenEndpoint: explicit.tokenEndpoint || doc.token_endpoint || '',
      jwksUri: explicit.jwksUri || doc.jwks_uri || '',
    };
    if (!endpoints.authorizationEndpoint || !endpoints.tokenEndpoint || !endpoints.jwksUri) {
      throw new Error('oidc discovery document is incomplete');
    }
    this.discoveryCache.set(provider.id, { endpoints, at: Date.now() });
    return endpoints;
  }

  // --- code exchange --------------------------------------------------------

  /** Authorization-code → token exchange with the PKCE verifier. */
  async exchangeCode(
    provider: OidcProviderWire,
    endpoints: OidcEndpoints,
    code: string,
    codeVerifier: string,
    callbackUrl: string,
  ): Promise<{ idToken: string }> {
    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: callbackUrl,
      client_id: provider.client_id,
      code_verifier: codeVerifier,
    });
    // Public clients (PKCE-only) have no secret; confidential ones send it.
    if (provider.client_secret) body.set('client_secret', provider.client_secret);
    const res = await fetch(endpoints.tokenEndpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });
    if (!res.ok) throw new Error(`oidc token exchange failed (${res.status})`);
    const json = (await res.json()) as { id_token?: string };
    if (!json.id_token) throw new Error('oidc token response has no id_token');
    return { idToken: json.id_token };
  }

  // --- id_token validation --------------------------------------------------

  /** Overridable in tests: fetch the signing key for `kid` from the JWKS. */
  async getPublicKey(jwksUri: string, kid: string | undefined): Promise<string> {
    let client = this.jwksClients.get(jwksUri);
    if (!client) {
      client = new JwksClient({
        jwksUri,
        cache: true,
        cacheMaxAge: 10 * 60 * 1000,
        rateLimit: true,
        jwksRequestsPerMinute: 10,
      });
      this.jwksClients.set(jwksUri, client);
    }
    const key = await client.getSigningKey(kid);
    return key.getPublicKey();
  }

  /**
   * Validate the id_token: allow-listed asymmetric alg, signature against the
   * provider JWKS, `iss` (exact configured issuer), `aud` (our client_id),
   * `exp`/`nbf`, and the login's `nonce`. Anything off → throw.
   */
  async verifyIdToken(
    provider: OidcProviderWire,
    endpoints: OidcEndpoints,
    idToken: string,
    expectedNonce: string,
  ): Promise<OidcIdentityClaims> {
    const [headerB64] = idToken.split('.');
    let header: { alg?: string; kid?: string };
    try {
      header = JSON.parse(Buffer.from(headerB64 ?? '', 'base64url').toString('utf8')) as {
        alg?: string;
        kid?: string;
      };
    } catch {
      throw new Error('oidc id_token is malformed');
    }
    const alg = header.alg ?? '';
    if (!ALLOWED_ID_TOKEN_ALGS.has(alg)) {
      // notably rejects `none` and HS* — an HS-signed token would let anyone
      // knowing the (public) client_id-derived secret forge identities.
      throw new Error(`oidc id_token alg not allowed: ${alg || 'none'}`);
    }
    const publicKey = await this.getPublicKey(endpoints.jwksUri, header.kid);
    const payload = (await this.jwt.verifyAsync(idToken, {
      publicKey,
      algorithms: [alg as never],
      issuer: provider.issuer,
      audience: provider.client_id,
      nonce: expectedNonce,
    })) as Record<string, unknown>;

    // jsonwebtoken enforces options.nonce, but keep an explicit belt-and-braces
    // check: a token replayed from another login attempt must never pass.
    if ((payload.nonce ?? '') !== expectedNonce) {
      throw new Error('oidc id_token nonce mismatch');
    }
    const subject = typeof payload.sub === 'string' ? payload.sub.trim() : '';
    if (!subject) throw new Error('oidc id_token has no sub');

    const email = typeof payload.email === 'string' ? payload.email.trim().toLowerCase() : '';
    const name =
      (typeof payload.name === 'string' && payload.name.trim()) ||
      (typeof payload.preferred_username === 'string' && payload.preferred_username.trim()) ||
      [payload.given_name, payload.family_name]
        .filter((p): p is string => typeof p === 'string' && !!p.trim())
        .join(' ') ||
      email;
    return {
      subject,
      email,
      emailVerified: payload.email_verified === true,
      name,
      avatarUrl: typeof payload.picture === 'string' ? payload.picture : '',
    };
  }
}
