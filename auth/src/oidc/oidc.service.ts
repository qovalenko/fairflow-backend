import { Injectable, Logger } from '@nestjs/common';
import { newEntityId } from '@fairflow/shared';
import { PrismaService } from '../prisma/prisma.service';
import { AppConfigService } from '../config/app-config.service';
import { AuthService, LoginResult, SessionContext } from '../auth/auth.service';
import { AppError } from '../common/errors';

/** Public provider info, safe for the unauthenticated login page. */
export interface OidcProviderPublic {
  id: string;
  name: string;
  issuer: string;
}

/** Full client config for the gateway (includes the client secret — gRPC only). */
export interface OidcProviderConfig extends OidcProviderPublic {
  clientId: string;
  clientSecret: string;
  discoveryUrl: string | null;
  authorizationEndpoint: string | null;
  tokenEndpoint: string | null;
  userInfoEndpoint: string | null;
  jwksUri: string | null;
  scopes: string[];
  trustEmail: boolean;
  isActive?: boolean;
  fromEnv?: boolean;
  createdAt?: Date;
  updatedAt?: Date;
}

/** Identity resolved by the gateway from a VALIDATED id_token. */
export interface OidcLoginInput {
  providerId: string;
  issuer: string;
  subject: string;
  email?: string;
  emailVerified?: boolean;
  name?: string;
  avatarUrl?: string;
}

/**
 * Env-declared provider (`OIDC_PROVIDERS` — JSON array). Lets a box customer
 * plug their Keycloak/ADFS without a rebuild or DB access:
 *   OIDC_PROVIDERS='[{"id":"keycloak","name":"Corporate SSO",
 *     "issuer":"https://kc.example.com/realms/main","clientId":"fairflow",
 *     "clientSecret":"…","scopes":["openid","profile","email"]}]'
 * Endpoints may be omitted — the gateway resolves them via OIDC discovery
 * (`<issuer>/.well-known/openid-configuration` or explicit `discoveryUrl`).
 */
interface EnvOidcProvider {
  id?: string;
  name?: string;
  issuer?: string;
  clientId?: string;
  clientSecret?: string;
  discoveryUrl?: string;
  authorizationEndpoint?: string;
  tokenEndpoint?: string;
  userInfoEndpoint?: string;
  jwksUri?: string;
  scopes?: string[];
  trustEmail?: boolean;
}

const DEFAULT_SCOPES = ['openid', 'profile', 'email'];

/**
 * OIDC/SSO — Fairflow as an OIDC *client* (FR-AUTH-350). This service owns
 * provider configuration (DB `OidcProvider` rows merged with the
 * `OIDC_PROVIDERS` env) and identity resolution (external identity → local
 * User). All external HTTP (discovery, code exchange, JWKS) happens on the
 * gateway — auth never talks to the IdP.
 */
@Injectable()
export class OidcService {
  private readonly logger = new Logger(OidcService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: AppConfigService,
    private readonly auth: AuthService,
  ) {}

  /** Kept for the (unwired) "Fairflow as provider" contour — WellKnownController. */
  async getDiscovery(): Promise<Record<string, unknown>> {
    const issuer = this.config.oauth2Issuer;
    return {
      issuer,
      authorization_endpoint: `${issuer}/api/v1/oauth/authorize`,
      token_endpoint: `${issuer}/api/v1/oauth/token`,
      introspection_endpoint: `${issuer}/api/v1/oauth/introspect`,
      revocation_endpoint: `${issuer}/api/v1/oauth/revoke`,
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code', 'refresh_token', 'client_credentials'],
      token_endpoint_auth_methods_supported: ['client_secret_basic', 'client_secret_post'],
      scopes_supported: ['openid', 'profile', 'email'],
    };
  }

  private envProviders(): OidcProviderConfig[] {
    const raw = (process.env.OIDC_PROVIDERS ?? '').trim();
    if (!raw) return [];
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      this.logger.warn('OIDC_PROVIDERS is not valid JSON — env providers ignored');
      return [];
    }
    if (!Array.isArray(parsed)) {
      this.logger.warn('OIDC_PROVIDERS must be a JSON array — env providers ignored');
      return [];
    }
    const out: OidcProviderConfig[] = [];
    for (const item of parsed as EnvOidcProvider[]) {
      const id = (item?.id ?? '').trim();
      const issuer = (item?.issuer ?? '').trim();
      const clientId = (item?.clientId ?? '').trim();
      if (!id || !issuer || !clientId) {
        this.logger.warn('OIDC_PROVIDERS entry skipped: id, issuer and clientId are required');
        continue;
      }
      out.push({
        id,
        name: (item.name ?? '').trim() || id,
        issuer,
        clientId,
        clientSecret: (item.clientSecret ?? '').trim(),
        discoveryUrl: (item.discoveryUrl ?? '').trim() || null,
        authorizationEndpoint: (item.authorizationEndpoint ?? '').trim() || null,
        tokenEndpoint: (item.tokenEndpoint ?? '').trim() || null,
        userInfoEndpoint: (item.userInfoEndpoint ?? '').trim() || null,
        jwksUri: (item.jwksUri ?? '').trim() || null,
        scopes:
          Array.isArray(item.scopes) && item.scopes.length
            ? item.scopes.map(String)
            : DEFAULT_SCOPES,
        trustEmail: item.trustEmail === true,
      });
    }
    return out;
  }

  private async dbProviders(): Promise<OidcProviderConfig[]> {
    const rows = await this.prisma.oidcProvider.findMany({ where: { isActive: true } });
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      issuer: r.issuer,
      clientId: r.clientId,
      clientSecret: r.clientSecret,
      discoveryUrl: r.discoveryUrl,
      authorizationEndpoint: r.authorizationEndpoint,
      tokenEndpoint: r.tokenEndpoint,
      userInfoEndpoint: r.userInfoEndpoint,
      jwksUri: r.jwksUri,
      scopes: r.scopes.length ? r.scopes : DEFAULT_SCOPES,
      trustEmail: r.trustEmail === true,
    }));
  }

  /** Active providers: DB rows merged with env; env wins on id collision. */
  private async allProviders(): Promise<OidcProviderConfig[]> {
    const env = this.envProviders();
    const envIds = new Set(env.map((p) => p.id));
    const db = (await this.dbProviders()).filter((p) => !envIds.has(p.id));
    return [...env, ...db];
  }

  async listProviders(): Promise<OidcProviderPublic[]> {
    const all = await this.allProviders();
    return all.map(({ id, name, issuer }) => ({ id, name, issuer }));
  }

  async getProviderConfig(id: string): Promise<OidcProviderConfig | undefined> {
    const key = (id ?? '').trim();
    if (!key) return undefined;
    return (await this.allProviders()).find((p) => p.id === key);
  }

  /** Admin registry: env providers (read-only) + DB rows. */
  async listProvidersAdmin(): Promise<OidcProviderConfig[]> {
    const env = this.envProviders().map((p) => ({
      ...p,
      isActive: true,
      fromEnv: true,
    }));
    const envIds = new Set(env.map((p) => p.id));
    const dbRows = await this.prisma.oidcProvider.findMany({ orderBy: { name: 'asc' } });
    const db = dbRows.map((r) => ({
      id: r.id,
      name: r.name,
      issuer: r.issuer,
      clientId: r.clientId,
      clientSecret: r.clientSecret,
      discoveryUrl: r.discoveryUrl,
      authorizationEndpoint: r.authorizationEndpoint,
      tokenEndpoint: r.tokenEndpoint,
      userInfoEndpoint: r.userInfoEndpoint,
      jwksUri: r.jwksUri,
      scopes: r.scopes.length ? r.scopes : DEFAULT_SCOPES,
      trustEmail: r.trustEmail,
      isActive: r.isActive,
      fromEnv: false,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
    }));
    return [...env, ...db.filter((p) => !envIds.has(p.id))];
  }

  async upsertProvider(input: {
    id: string;
    name: string;
    issuer: string;
    clientId: string;
    clientSecret?: string;
    discoveryUrl?: string | null;
    authorizationEndpoint?: string | null;
    tokenEndpoint?: string | null;
    userInfoEndpoint?: string | null;
    jwksUri?: string | null;
    scopes?: string[];
    isActive?: boolean;
    trustEmail?: boolean;
  }): Promise<OidcProviderConfig> {
    const id = input.id.trim();
    const issuer = input.issuer.trim();
    const clientId = input.clientId.trim();
    if (!id || !issuer || !clientId) {
      throw new AppError('invalid', 'id, issuer and clientId are required');
    }
    if (this.envProviders().some((p) => p.id === id)) {
      throw new AppError('access', 'provider id is owned by OIDC_PROVIDERS env');
    }
    const existing = await this.prisma.oidcProvider.findUnique({ where: { id } });
    const secret = (input.clientSecret ?? '').trim() || existing?.clientSecret || '';
    if (!secret) throw new AppError('invalid', 'clientSecret is required for a new provider');
    const keep = (incoming: string | null | undefined, current: string | null | undefined) => {
      const t = (incoming ?? '').trim();
      return t ? t : (current ?? null);
    };
    const row = await this.prisma.oidcProvider.upsert({
      where: { id },
      create: {
        id,
        name: input.name.trim() || id,
        issuer,
        clientId,
        clientSecret: secret,
        discoveryUrl: input.discoveryUrl ?? null,
        authorizationEndpoint: input.authorizationEndpoint ?? null,
        tokenEndpoint: input.tokenEndpoint ?? null,
        userInfoEndpoint: input.userInfoEndpoint ?? null,
        jwksUri: input.jwksUri ?? null,
        scopes: input.scopes?.length ? input.scopes : DEFAULT_SCOPES,
        trustEmail: input.trustEmail === true,
        isActive: input.isActive ?? true,
      },
      update: {
        name: input.name.trim() || id,
        issuer,
        clientId,
        ...(input.clientSecret?.trim() ? { clientSecret: input.clientSecret.trim() } : {}),
        discoveryUrl: keep(input.discoveryUrl, existing?.discoveryUrl),
        authorizationEndpoint: keep(input.authorizationEndpoint, existing?.authorizationEndpoint),
        tokenEndpoint: keep(input.tokenEndpoint, existing?.tokenEndpoint),
        userInfoEndpoint: keep(input.userInfoEndpoint, existing?.userInfoEndpoint),
        jwksUri: keep(input.jwksUri, existing?.jwksUri),
        scopes: input.scopes?.length
          ? input.scopes
          : existing?.scopes?.length
            ? existing.scopes
            : DEFAULT_SCOPES,
        ...(input.trustEmail !== undefined ? { trustEmail: input.trustEmail === true } : {}),
        ...(input.isActive !== undefined ? { isActive: input.isActive } : {}),
      },
    });
    return {
      id: row.id,
      name: row.name,
      issuer: row.issuer,
      clientId: row.clientId,
      clientSecret: row.clientSecret,
      discoveryUrl: row.discoveryUrl,
      authorizationEndpoint: row.authorizationEndpoint,
      tokenEndpoint: row.tokenEndpoint,
      userInfoEndpoint: row.userInfoEndpoint,
      jwksUri: row.jwksUri,
      scopes: row.scopes,
      trustEmail: row.trustEmail,
      isActive: row.isActive,
      fromEnv: false,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }

  async deactivateProvider(id: string): Promise<void> {
    const key = (id ?? '').trim();
    if (!key) throw new AppError('invalid', 'id is required');
    if (this.envProviders().some((p) => p.id === key)) {
      throw new AppError('access', 'env-owned provider cannot be deactivated via API');
    }
    await this.prisma.oidcProvider.updateMany({ where: { id: key }, data: { isActive: false } });
  }

  /**
   * Resolve a VALIDATED external identity into a local session (FR-AUTH-350).
   *
   * 1. Existing link (issuer, subject) → that User, regardless of the current
   *    email (stable binding survives email changes on either side).
   * 2. No link yet → bind by provider-VERIFIED email: an existing User with that
   *    email is linked (never duplicated); otherwise an external-only account is
   *    provisioned (random unusable password, emailVerified=true).
   *
   * An UNVERIFIED provider email is rejected: accepting it would let anyone able
   * to register that address at the IdP take over the matching local account.
   * The gateway already rejects it; this re-check is defense in depth.
   */
  async login(input: OidcLoginInput, ctx?: SessionContext): Promise<LoginResult> {
    const issuer = (input.issuer ?? '').trim();
    const subject = (input.subject ?? '').trim();
    if (!issuer || !subject) {
      throw new AppError('auth', 'oidc: issuer and subject are required');
    }

    const link = await this.prisma.userOidcIdentity.findUnique({
      where: { issuer_subject: { issuer, subject } },
      select: { userId: true },
    });
    if (link) {
      const user = await this.prisma.user.findFirst({
        where: { id: link.userId, isActive: true },
        select: { id: true },
      });
      if (!user) throw new AppError('auth', 'oidc: account is not active');
      return this.auth.startSessionOrChallenge(user.id, ctx);
    }

    const email = (input.email ?? '').trim().toLowerCase();
    if (!email || !email.includes('@')) {
      throw new AppError('auth', 'oidc: provider did not return an email');
    }
    if (input.emailVerified !== true) {
      throw new AppError('auth', 'oidc: email is not verified by the provider');
    }

    // Find-or-create by email (never creates a duplicate for an existing email)
    // and start the session / 2FA challenge — same path as social login.
    const result = await this.auth.oauthLogin(
      {
        provider: input.providerId,
        externalId: subject,
        email,
        name: input.name,
        avatarUrl: input.avatarUrl,
      },
      ctx,
    );

    // Persist the identity link so future logins match by (issuer, subject).
    // Best-effort: a failure here must not lose the just-issued session.
    try {
      const user = await this.prisma.user.findFirst({
        where: { email },
        select: { id: true },
      });
      if (user) {
        await this.prisma.userOidcIdentity.upsert({
          where: { issuer_subject: { issuer, subject } },
          create: { id: newEntityId(), userId: user.id, issuer, subject, email },
          update: { email },
        });
      }
    } catch (e) {
      this.logger.warn(
        { err: (e as Error).message, issuer, subject },
        'oidc: failed to persist identity link',
      );
    }
    return result;
  }
}
