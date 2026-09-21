import {
  Controller,
  Get,
  Query,
  Req,
  Res,
  Inject,
  OnModuleInit,
  ServiceUnavailableException,
  VERSION_NEUTRAL,
} from '@nestjs/common';
import { ClientGrpcProxy } from '@nestjs/microservices';
import { ApiTags, ApiOperation } from '@nestjs/swagger';
import { randomBytes } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { grpcBffCall } from '../bff/grpc-bff-call';
import { Public } from '../common/public.decorator';
import { GatewayOutboundMetadataService } from '../bff/gateway-outbound-metadata.service';
import { GatewayEventsService } from '../events/gateway-events.service';
import { AuthEmployeeGateService } from './auth-employee-gate.service';

/**
 * Yandex OAuth (social login) — identity-auth/TZ.md SSO.
 *
 * Flow:
 *   GET /api/auth/oauth/yandex?redirectUrl=<spa>  → 302 to Yandex authorize
 *   GET /api/auth/oauth/yandex/callback?code&state → exchange code → userinfo
 *        → auth.OauthLogin (find-or-create + issue session)
 *        → 302 to SPA handoff route `${spaBaseUrl}/auth/oauth/callback#access_token=…`
 *
 * The access token is handed to the SPA in the URL *fragment* (not the query): the
 * fragment never reaches the server / proxies / access logs, and the SPA handoff
 * page consumes it client-side (store it in localStorage / mark the session) then
 * scrubs it from history. The HttpOnly cookie is still set as well so the
 * `cookies` persist-strategy keeps working; the SPA picks whichever it needs.
 *
 * The gateway is the egress point, so the provider HTTP exchange happens here; the
 * auth domain stays free of external HTTP and only does identity resolution.
 *
 * Config (env): YANDEX_OAUTH_CLIENT_ID, YANDEX_OAUTH_CLIENT_SECRET,
 *   YANDEX_OAUTH_CALLBACK_URL (default <publicUrl>/api/auth/oauth/yandex/callback).
 * When clientId/secret are absent the routes stay live but respond 503 (stub) so
 * the SPA can detect provider availability without crashing the gateway.
 */
// VERSION_NEUTRAL: the gateway applies setGlobalPrefix('api') + URI versioning (defaultVersion '1'),
// which would mount this at /api/v1/... — but the whole Yandex flow (this controller's hardcoded
// callback path, the SPA button, and the redirect_uri registered in the Yandex app console) is
// /api/auth/oauth/yandex(/callback) with NO version segment. Pin it version-neutral so all three align.
@Controller({ path: 'auth/oauth/yandex', version: VERSION_NEUTRAL })
export class OauthYandexController implements OnModuleInit {
  private static readonly AUTHORIZE_URL = 'https://oauth.yandex.ru/authorize';
  private static readonly TOKEN_URL = 'https://oauth.yandex.ru/token';
  private static readonly USERINFO_URL = 'https://login.yandex.ru/info?format=json';
  private static readonly ACCESS_COOKIE = 'ff_access_token';
  /** SPA route that finishes the OAuth handoff (reads the token from the fragment). */
  private static readonly SPA_HANDOFF_PATH = '/auth/oauth/callback';
  /** state → original SPA redirectUrl; short-lived CSRF protection (in-memory, single instance). */
  private readonly pendingStates = new Map<string, { redirectUrl: string; at: number }>();

  private authGrpc!: { oauthLogin: (x: unknown, m?: unknown) => unknown };

  constructor(
    @Inject('AUTH_GRPC') private readonly authClient: ClientGrpcProxy,
    private readonly outboundMeta: GatewayOutboundMetadataService,
    private readonly gatewayEvents: GatewayEventsService,
    private readonly employeeGate: AuthEmployeeGateService,
  ) {}

  onModuleInit() {
    this.authGrpc = this.authClient.getService('AuthGrpc');
  }

  private get clientId(): string {
    return (process.env.YANDEX_OAUTH_CLIENT_ID ?? '').trim();
  }
  private get clientSecret(): string {
    return (process.env.YANDEX_OAUTH_CLIENT_SECRET ?? '').trim();
  }
  private get callbackUrl(): string {
    const explicit = (process.env.YANDEX_OAUTH_CALLBACK_URL ?? '').trim();
    if (explicit) return explicit;
    const base = (process.env.GATEWAY_PUBLIC_URL ?? 'http://localhost:3000').replace(/\/+$/, '');
    return `${base}/api/auth/oauth/yandex/callback`;
  }
  private get spaBaseUrl(): string {
    return (process.env.APP_PUBLIC_URL ?? 'http://localhost:5173').replace(/\/+$/, '');
  }

  private ensureConfigured() {
    if (!this.clientId || !this.clientSecret) {
      throw new ServiceUnavailableException('Yandex OAuth is not configured');
    }
  }

  private sweepStates() {
    const cutoff = Date.now() - 10 * 60 * 1000; // 10 min TTL
    for (const [k, v] of this.pendingStates) if (v.at < cutoff) this.pendingStates.delete(k);
  }

  @Public()
  @Get()
  @ApiTags('Auth')
  @ApiOperation({ summary: 'Begin Yandex OAuth — 302 to provider authorize' })
  start(@Query('redirectUrl') redirectUrl: string | undefined, @Res() reply: FastifyReply) {
    this.ensureConfigured();
    this.sweepStates();
    const state = randomBytes(16).toString('hex');
    this.pendingStates.set(state, {
      redirectUrl: (redirectUrl ?? '').trim() || this.spaBaseUrl,
      at: Date.now(),
    });
    const params = new URLSearchParams({
      response_type: 'code',
      client_id: this.clientId,
      redirect_uri: this.callbackUrl,
      state,
    });
    reply.redirect(`${OauthYandexController.AUTHORIZE_URL}?${params.toString()}`, 302);
  }

  @Public()
  @Get('callback')
  @ApiTags('Auth')
  @ApiOperation({ summary: 'Yandex OAuth callback — issue session and redirect to SPA' })
  async callback(
    @Query('code') code: string | undefined,
    @Query('state') state: string | undefined,
    @Query('error') error: string | undefined,
    @Req() req: FastifyRequest,
    @Res() reply: FastifyReply,
  ) {
    this.ensureConfigured();
    const entry = state ? this.pendingStates.get(state) : undefined;
    if (state) this.pendingStates.delete(state);
    if (!entry || !state) {
      return reply.redirect(this.handoffError('oauth_invalid_state', this.spaBaseUrl), 302);
    }
    const spaTarget = entry.redirectUrl;

    if (error || !code) {
      return reply.redirect(this.handoffError(error || 'oauth_failed', spaTarget), 302);
    }

    let identity: { externalId: string; email: string; name: string; avatarUrl: string };
    try {
      const accessToken = await this.exchangeCode(code);
      identity = await this.fetchUserInfo(accessToken);
    } catch {
      return reply.redirect(this.handoffError('oauth_exchange_failed', spaTarget), 302);
    }
    if (!identity.email) {
      return reply.redirect(this.handoffError('oauth_no_email', spaTarget), 302);
    }

    const md = this.outboundMeta.build(req as FastifyRequest & { user?: { userId?: string } });
    let grpcRes: Record<string, unknown>;
    try {
      grpcRes = (await grpcBffCall(
        this.authGrpc.oauthLogin(
          {
            provider: 'yandex',
            external_id: identity.externalId,
            email: identity.email,
            name: identity.name,
            avatar_url: identity.avatarUrl,
          },
          md,
        ) as never,
      )) as Record<string, unknown>;
    } catch {
      return reply.redirect(this.handoffError('oauth_login_failed', spaTarget), 302);
    }

    // 2FA: provider login accepted but a second factor is still required. Hand the
    // pre-auth id to the SPA handoff page (in the fragment) so it can route to the
    // 2FA screen — mirrors the password-login `mfaRequired`/`preauthId` flow.
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
        `${OauthYandexController.ACCESS_COOKIE}=; Path=/; HttpOnly; Max-Age=0; SameSite=Lax`,
      );
      return reply.redirect(this.handoffError('oauth_not_employee', spaTarget), 302);
    }
    // Cookie stays (harmless; serves the `cookies` persist-strategy). The SPA
    // handoff page reads the token from the fragment for the localStorage model.
    this.setAccessCookie(reply, token);
    if (userId) {
      void this.gatewayEvents.authLogin(userId, { method: 'oauth_yandex', ip: req.ip });
    }
    return reply.redirect(this.handoff({ access_token: token, redirectUrl: spaTarget }), 302);
  }

  private async exchangeCode(code: string): Promise<string> {
    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      client_id: this.clientId,
      client_secret: this.clientSecret,
      redirect_uri: this.callbackUrl,
    });
    const res = await fetch(OauthYandexController.TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });
    if (!res.ok) throw new Error('token exchange failed');
    const json = (await res.json()) as { access_token?: string };
    if (!json.access_token) throw new Error('no access_token');
    return json.access_token;
  }

  private async fetchUserInfo(
    providerToken: string,
  ): Promise<{ externalId: string; email: string; name: string; avatarUrl: string }> {
    const res = await fetch(OauthYandexController.USERINFO_URL, {
      headers: { Authorization: `OAuth ${providerToken}` },
    });
    if (!res.ok) throw new Error('userinfo failed');
    const u = (await res.json()) as {
      id?: string;
      default_email?: string;
      emails?: string[];
      real_name?: string;
      display_name?: string;
      default_avatar_id?: string;
      is_avatar_empty?: boolean;
    };
    const email = (u.default_email || u.emails?.[0] || '').toLowerCase();
    const avatarUrl =
      u.default_avatar_id && !u.is_avatar_empty
        ? `https://avatars.yandex.net/get-yapic/${u.default_avatar_id}/islands-200`
        : '';
    return {
      externalId: u.id ?? '',
      email,
      name: u.real_name || u.display_name || email,
      avatarUrl,
    };
  }

  /**
   * Build the SPA handoff URL `${spaBaseUrl}/auth/oauth/callback#<params>`.
   * Everything sensitive (access_token, error reason, preauthId) goes in the
   * fragment so it never hits the server / proxy access logs; the SPA page reads
   * it client-side and immediately scrubs it from history.
   */
  private handoff(params: Record<string, string | undefined>): string {
    const frag = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) {
      if (v) frag.set(k, v);
    }
    return `${this.spaBaseUrl}${OauthYandexController.SPA_HANDOFF_PATH}#${frag.toString()}`;
  }

  private handoffError(code: string, redirectUrl: string): string {
    return this.handoff({ error: code, redirectUrl });
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
      `${OauthYandexController.ACCESS_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${
        process.env.NODE_ENV === 'production' ? '; Secure' : ''
      }`,
    );
  }
}
