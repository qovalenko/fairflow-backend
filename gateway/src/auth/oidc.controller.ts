import {
  Controller,
  Get,
  Inject,
  NotFoundException,
  OnModuleInit,
  Param,
  Query,
  Req,
  Res,
  VERSION_NEUTRAL,
} from '@nestjs/common';
import { ClientGrpcProxy } from '@nestjs/microservices';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { grpcBffCall } from '../bff/grpc-bff-call';
import { GatewayOutboundMetadataService } from '../bff/gateway-outbound-metadata.service';
import { GatewayEventsService } from '../events/gateway-events.service';
import { Public } from '../common/public.decorator';
import {
  OidcClientService,
  type OidcEndpoints,
  type OidcProviderWire,
} from './oidc-client.service';
import { AuthEmployeeGateService } from './auth-employee-gate.service';

interface OidcGrpcClient {
  listProviders: (x: unknown, m?: unknown) => unknown;
  getProviderConfig: (x: unknown, m?: unknown) => unknown;
  oidcLogin: (x: unknown, m?: unknown) => unknown;
}

/**
 * External OIDC SSO — Fairflow as an OIDC *client* (FR-AUTH-350). Corporate SSO
 * (Keycloak / ADFS / Yandex ID …) through the standard code flow with PKCE.
 *
 * Flow:
 *   GET /api/auth/oidc/providers                  → providers for the login page
 *   GET /api/auth/oidc/:providerId/start?redirectUrl=<spa>
 *       → 302 to the IdP authorize endpoint (state + nonce + PKCE S256)
 *   GET /api/auth/oidc/callback?code&state
 *       → one-time state check → code exchange (PKCE verifier) → id_token
 *         validation (JWKS signature, iss, aud, exp, nonce) → auth.OidcGrpc.OidcLogin
 *       → 302 to the SPA handoff route with the token in the URL *fragment*
 *         (same handoff contract as the Yandex OAuth controller).
 *
 * The gateway is the egress point: every provider HTTP call happens here; the
 * auth domain only stores provider config and resolves the validated identity
 * over gRPC. Provider config comes from auth (OidcProvider table merged with
 * the OIDC_PROVIDERS env there) — a box customer plugs their Keycloak via env
 * without a rebuild.
 *
 * Register at the IdP: redirect URI `<GATEWAY_PUBLIC_URL>/api/auth/oidc/callback`.
 */
// VERSION_NEUTRAL for the same reason as the Yandex controller: the callback
// path is registered verbatim in the IdP console — no /v1 segment.
@Controller({ path: 'auth/oidc', version: VERSION_NEUTRAL })
export class OidcBffController implements OnModuleInit {
  private static readonly ACCESS_COOKIE = 'ff_access_token';
  /** SPA route that finishes the handoff (reads the token from the fragment). */
  private static readonly SPA_HANDOFF_PATH = '/auth/oauth/callback';

  private oidcGrpc!: OidcGrpcClient;

  constructor(
    @Inject('AUTH_GRPC') private readonly authClient: ClientGrpcProxy,
    private readonly outboundMeta: GatewayOutboundMetadataService,
    private readonly oidc: OidcClientService,
    private readonly gatewayEvents: GatewayEventsService,
    private readonly employeeGate: AuthEmployeeGateService,
  ) {}

  onModuleInit() {
    this.oidcGrpc = this.authClient.getService<OidcGrpcClient>('OidcGrpc');
  }

  private get callbackUrl(): string {
    const explicit = (process.env.OIDC_CALLBACK_URL ?? '').trim();
    if (explicit) return explicit;
    const base = (process.env.GATEWAY_PUBLIC_URL ?? 'http://localhost:3000').replace(/\/+$/, '');
    return `${base}/api/auth/oidc/callback`;
  }

  private get spaBaseUrl(): string {
    return (process.env.APP_PUBLIC_URL ?? 'http://localhost:5173').replace(/\/+$/, '');
  }

  private async providerConfig(
    providerId: string,
    req: FastifyRequest,
  ): Promise<OidcProviderWire | undefined> {
    const md = this.outboundMeta.build(req as FastifyRequest & { user?: { userId?: string } });
    try {
      return (await grpcBffCall(
        this.oidcGrpc.getProviderConfig({ id: providerId }, md) as never,
      )) as OidcProviderWire;
    } catch {
      return undefined;
    }
  }

  @Public()
  @Get('providers')
  @ApiTags('Auth')
  @ApiOperation({ summary: 'Active external OIDC providers (for the login page)' })
  async providers(@Req() req: FastifyRequest) {
    const md = this.outboundMeta.build(req as FastifyRequest & { user?: { userId?: string } });
    const r = (await grpcBffCall(this.oidcGrpc.listProviders({}, md) as never)) as {
      providers?: { id?: string; name?: string; issuer?: string }[];
    };
    // Public projection only — provider secrets never leave the gRPC layer.
    return {
      providers: (r.providers ?? []).map((p) => ({
        id: p.id ?? '',
        name: p.name ?? '',
        issuer: p.issuer ?? '',
      })),
    };
  }

  @Public()
  @Get(':providerId/start')
  @ApiTags('Auth')
  @ApiOperation({ summary: 'Begin external OIDC login — 302 to the provider (PKCE S256)' })
  async start(
    @Param('providerId') providerId: string,
    @Query('redirectUrl') redirectUrl: string | undefined,
    @Req() req: FastifyRequest,
    @Res() reply: FastifyReply,
  ) {
    const provider = await this.providerConfig((providerId ?? '').trim(), req);
    if (!provider) throw new NotFoundException('Unknown OIDC provider');
    let endpoints: OidcEndpoints;
    try {
      endpoints = await this.oidc.resolveEndpoints(provider);
    } catch {
      return reply.redirect(
        this.handoffError('oidc_discovery_failed', (redirectUrl ?? '').trim() || this.spaBaseUrl),
        302,
      );
    }
    const { authorizeUrl } = this.oidc.begin(
      provider,
      endpoints,
      this.callbackUrl,
      (redirectUrl ?? '').trim() || this.spaBaseUrl,
    );
    return reply.redirect(authorizeUrl, 302);
  }

  @Public()
  @Get('callback')
  @ApiTags('Auth')
  @ApiOperation({ summary: 'External OIDC callback — validate, issue session, redirect to SPA' })
  async callback(
    @Query('code') code: string | undefined,
    @Query('state') state: string | undefined,
    @Query('error') error: string | undefined,
    @Req() req: FastifyRequest,
    @Res() reply: FastifyReply,
  ) {
    // One-time state: unknown / reused / expired → treat as CSRF and stop before
    // touching the provider or spending the code.
    const entry = this.oidc.consumeState(state);
    if (!entry) {
      return reply.redirect(this.handoffError('oidc_state_mismatch', this.spaBaseUrl), 302);
    }
    const spaTarget = entry.redirectUrl || this.spaBaseUrl;
    if (error || !code) {
      return reply.redirect(this.handoffError(error || 'oidc_failed', spaTarget), 302);
    }

    const provider = await this.providerConfig(entry.providerId, req);
    if (!provider) {
      return reply.redirect(this.handoffError('oidc_provider_gone', spaTarget), 302);
    }

    let identity: Awaited<ReturnType<OidcClientService['verifyIdToken']>>;
    try {
      const endpoints = await this.oidc.resolveEndpoints(provider);
      const { idToken } = await this.oidc.exchangeCode(
        provider,
        endpoints,
        code,
        entry.codeVerifier,
        this.callbackUrl,
      );
      identity = await this.oidc.verifyIdToken(provider, endpoints, idToken, entry.nonce);
    } catch {
      return reply.redirect(this.handoffError('oidc_exchange_failed', spaTarget), 302);
    }

    if (!identity.email) {
      return reply.redirect(this.handoffError('oidc_no_email', spaTarget), 302);
    }
    // Binding policy: only a provider-VERIFIED email may attach to (or create)
    // a local account — otherwise anyone able to claim the address at the IdP
    // could take over the matching Fairflow account. `trust_email` (explicit
    // per-provider opt-in for IdPs that omit the claim, e.g. ADFS) counts as
    // verified. Auth re-checks the flag (defense in depth).
    const emailVerified = identity.emailVerified || provider.trust_email === true;
    if (!emailVerified) {
      return reply.redirect(this.handoffError('oidc_email_unverified', spaTarget), 302);
    }

    const md = this.outboundMeta.build(req as FastifyRequest & { user?: { userId?: string } });
    let grpcRes: Record<string, unknown>;
    try {
      grpcRes = (await grpcBffCall(
        this.oidcGrpc.oidcLogin(
          {
            provider_id: provider.id,
            issuer: provider.issuer,
            subject: identity.subject,
            email: identity.email,
            email_verified: emailVerified,
            name: identity.name,
            avatar_url: identity.avatarUrl,
            device_label: (req.headers['user-agent'] ?? '').toString().slice(0, 255),
            ip: req.ip ?? '',
          },
          md,
        ) as never,
      )) as Record<string, unknown>;
    } catch {
      return reply.redirect(this.handoffError('oidc_login_failed', spaTarget), 302);
    }

    // 2FA challenge — mirror the password/Yandex flow: hand preauthId to the SPA.
    if (grpcRes.mfa_required ?? grpcRes.mfaRequired) {
      const preauthId = (grpcRes.preauth_id ?? grpcRes.preauthId ?? '') as string;
      return reply.redirect(
        this.handoff({ mfaRequired: '1', preauthId, redirectUrl: spaTarget }),
        302,
      );
    }

    const token = (grpcRes.access_token ?? grpcRes.accessToken ?? '') as string;
    const userId = String((grpcRes.user as { id?: unknown } | undefined)?.id ?? '');
    if (!userId || !(await this.employeeGate.isActiveEmployee(userId, req))) {
      reply.header(
        'Set-Cookie',
        `${OidcBffController.ACCESS_COOKIE}=; Path=/; HttpOnly; Max-Age=0; SameSite=Lax`,
      );
      return reply.redirect(this.handoffError('oidc_not_employee', spaTarget), 302);
    }
    this.setAccessCookie(reply, token);
    if (userId) {
      void this.gatewayEvents.authLogin(userId, { method: 'oidc', ip: req.ip });
    }
    return reply.redirect(this.handoff({ access_token: token, redirectUrl: spaTarget }), 302);
  }

  /**
   * SPA handoff `${spaBaseUrl}/auth/oauth/callback#<params>` — sensitive values
   * travel in the fragment (never reaches server/proxy logs); same contract as
   * the Yandex OAuth controller, so the SPA handoff page serves both flows.
   */
  private handoff(params: Record<string, string | undefined>): string {
    const frag = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) {
      if (v) frag.set(k, v);
    }
    return `${this.spaBaseUrl}${OidcBffController.SPA_HANDOFF_PATH}#${frag.toString()}`;
  }

  private handoffError(codeStr: string, redirectUrl: string): string {
    return this.handoff({ error: codeStr, redirectUrl });
  }

  private setAccessCookie(reply: FastifyReply, token: string): void {
    const expiresIn = process.env.JWT_EXPIRE ?? '24h';
    const m = expiresIn.match(/^(\d+)(d|h|m|s)?$/);
    let maxAge = 24 * 60 * 60;
    if (m) {
      const n = parseInt(m[1], 10);
      const unit = m[2] ?? 's';
      maxAge = unit === 'd' ? n * 86400 : unit === 'h' ? n * 3600 : unit === 'm' ? n * 60 : n;
    }
    reply.header(
      'Set-Cookie',
      `${OidcBffController.ACCESS_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${
        process.env.NODE_ENV === 'production' ? '; Secure' : ''
      }`,
    );
  }
}
