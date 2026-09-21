import {
  Controller,
  Post,
  Get,
  Patch,
  Body,
  UseGuards,
  Request,
  Req,
  Inject,
  OnModuleInit,
  UnauthorizedException,
  BadRequestException,
  ConflictException,
  ForbiddenException,
  ServiceUnavailableException,
  HttpException,
  HttpStatus,
  Logger,
  Res,
} from '@nestjs/common';
import { AuthPublicThrottleGuard } from './auth-public-throttle.guard';
import { AuthPublicThrottle, AUTH_PUBLIC_HOURLY_5 } from './auth-public-throttle.decorator';
import { ClientGrpcProxy } from '@nestjs/microservices';
import { status as GrpcStatus } from '@grpc/grpc-js';
import { JwtService } from '@nestjs/jwt';
import { grpcBffCall } from '../bff/grpc-bff-call';
import { decodeGrpcProject } from '../bff/project-grpc.codec';
import { ApiTags, ApiOperation, ApiBearerAuth, ApiBody } from '@nestjs/swagger';
import { LoginDto } from './dto/login.dto';
import { JwtAuthGuard } from './guards/jwt-auth.guard';
import { Public } from '../common/public.decorator';
import type { FastifyReply } from 'fastify';
import type { FastifyRequest } from 'fastify';
import { GatewayOutboundMetadataService } from '../bff/gateway-outbound-metadata.service';
import { AvatarStorageService } from './avatar-storage.service';
import { GatewayEventsService } from '../events/gateway-events.service';
import { gatewayAuthRateLimiter, rateLimitKeys } from './auth-rate-limit';
import type { Readable } from 'node:stream';

@Controller('auth')
@UseGuards(AuthPublicThrottleGuard)
export class AuthController implements OnModuleInit {
  private readonly logger = new Logger(AuthController.name);
  private static readonly ACCESS_COOKIE = 'ff_access_token';
  private static readonly PROFILE_ENUM = {
    language: new Set(['ru', 'en']),
    dateFormat: new Set(['DD.MM.YYYY', 'MM/DD/YYYY', 'YYYY-MM-DD']),
    timeFormat: new Set(['24h', '12h']),
    thousandsSeparator: new Set(['space', 'comma']),
    defaultDealsView: new Set(['kanban', 'list']),
    defaultActivitiesView: new Set(['list', 'calendar']),
  };
  private authGrpc!: {
    login: (x: unknown, m?: unknown) => unknown;
    verifyMfa: (x: unknown, m?: unknown) => unknown;
    register: (x: unknown, m?: unknown) => unknown;
    me: (x: unknown, m?: unknown) => unknown;
    updateMe: (x: unknown, m?: unknown) => unknown;
    logout: (x: unknown, m?: unknown) => unknown;
    requestPasswordReset: (x: unknown, m?: unknown) => unknown;
    resetPassword: (x: unknown, m?: unknown) => unknown;
    requestEmailVerification: (x: unknown, m?: unknown) => unknown;
    confirmEmailVerification: (x: unknown, m?: unknown) => unknown;
  };
  private notificationGrpc!: {
    sendTransactionalEmail: (x: unknown, m?: unknown) => unknown;
  };
  // control.ProjectGrpc — reused via the shared CONTROL_GRPC channel (same client
  // v1-data-bff uses for GET /v1/projects), so /me can hydrate user.projects.
  private projectGrpc!: {
    listMyProjects: (x: unknown, m?: unknown) => unknown;
  };

  /** Best-effort device label + client IP for the persisted Session (FR-MPROF-15). */
  private deviceContext(req: FastifyRequest): { device_label: string; ip: string } {
    const ua = req.headers['user-agent'];
    return {
      device_label: (typeof ua === 'string' ? ua : '').slice(0, 256),
      ip: this.clientIp(req),
    };
  }

  /** Honour X-Forwarded-For only when TRUST_PROXY is explicitly enabled. */
  private clientIp(req: FastifyRequest): string {
    const trustProxy = ['true', '1', 'on'].includes(
      String(process.env.TRUST_PROXY ?? '')
        .trim()
        .toLowerCase(),
    );
    if (trustProxy) {
      const fwd = req.headers['x-forwarded-for'];
      const fromFwd = (
        Array.isArray(fwd) ? fwd[0] : typeof fwd === 'string' ? fwd.split(',')[0] : ''
      )?.trim();
      if (fromFwd) return fromFwd.slice(0, 64);
    }
    return (req.ip ?? '').slice(0, 64);
  }

  constructor(
    @Inject('AUTH_GRPC') private readonly authClient: ClientGrpcProxy,
    @Inject('NOTIFICATION_GRPC') private readonly notificationClient: ClientGrpcProxy,
    @Inject('CONTROL_GRPC') private readonly controlClient: ClientGrpcProxy,
    private readonly outboundMeta: GatewayOutboundMetadataService,
    private readonly avatarStorage: AvatarStorageService,
    private readonly gatewayEvents: GatewayEventsService,
    private readonly jwt: JwtService,
  ) {}

  /** Public base URL of the SPA, used to build email deep-links. */
  private appBaseUrl(): string {
    return (process.env.APP_PUBLIC_URL ?? 'http://localhost:5173').replace(/\/+$/, '');
  }

  /**
   * Best-effort transactional email via the notification domain. Never throws —
   * auth flows must stay generic/idempotent even when the mailer is down.
   */
  private async sendAuthEmail(
    md: unknown,
    input: { to: string; kind: string; actionUrl: string; userName?: string },
  ): Promise<void> {
    if (!input.to) return;
    try {
      await grpcBffCall(
        this.notificationGrpc.sendTransactionalEmail(
          {
            to: input.to,
            kind: input.kind,
            action_url: input.actionUrl,
            user_name: input.userName ?? '',
          },
          md,
        ) as never,
      );
    } catch {
      // swallow — delivery is best-effort; the user still gets a generic 200.
    }
  }

  /** Read the calling token from the bearer header or the ff_access_token cookie. */
  private extractToken(req: FastifyRequest): string {
    const auth = req.headers['authorization'];
    if (typeof auth === 'string' && auth.startsWith('Bearer ')) return auth.slice(7).trim();
    const cookie = req.headers['cookie'];
    if (typeof cookie === 'string') {
      for (const part of cookie.split(';')) {
        const p = part.trim();
        if (p.startsWith(`${AuthController.ACCESS_COOKIE}=`)) {
          return decodeURIComponent(p.slice(AuthController.ACCESS_COOKIE.length + 1));
        }
      }
    }
    return '';
  }

  onModuleInit() {
    this.authGrpc = this.authClient.getService('AuthGrpc');
    this.notificationGrpc = this.notificationClient.getService('NotificationGrpc');
    this.projectGrpc = this.controlClient.getService('ProjectGrpc');
  }

  /**
   * Best-effort fetch of the caller's projects via control.ProjectGrpc.ListMyProjects.
   * /me is session-critical (see auth-session-resilience): control being down must
   * never fail the whole response — we degrade to an empty list and warn.
   * Returns Project objects — same shape GET /v1/projects emits (Struct-typed
   * fields decoded to plain JSON; the FE seeds ModulesTab state from this list
   * and PATCHes it back, so a wire-shape leak here corrupts saved settings).
   */
  private async listMyProjectsSafe(userId: string, md: unknown): Promise<unknown[]> {
    try {
      const r = (await grpcBffCall(
        this.projectGrpc.listMyProjects({ user_id: userId }, md) as never,
      )) as { list?: unknown[] };
      return (r?.list ?? []).map((p) =>
        p && typeof p === 'object' ? decodeGrpcProject(p as Record<string, unknown>) : p,
      );
    } catch (err) {
      this.logger.warn(
        `/me: ListMyProjects failed for user=${userId}, returning empty projects: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return [];
    }
  }

  private mapGrpcUserToApiUser(u: Record<string, unknown>) {
    const asString = (v: unknown, fallback = '') => (typeof v === 'string' ? v : fallback);
    return {
      userId: asString(u.id),
      userName: asString(u.login),
      email: asString(u.email),
      name: asString(u.name),
      authority: ['USER'],
      avatar: asString(u.avatar_url ?? u.avatarUrl),
      phone: asString(u.phone),
      position: asString(u.position),
      language: asString(u.language, 'ru'),
      timezone: asString(u.timezone, 'Europe/Moscow'),
      dateFormat: asString(u.date_format ?? u.dateFormat, 'DD.MM.YYYY'),
      timeFormat: asString(u.time_format ?? u.timeFormat, '24h'),
      thousandsSeparator: asString(u.thousands_separator ?? u.thousandsSeparator, 'space'),
      defaultDealsView: asString(u.default_deals_view ?? u.defaultDealsView, 'kanban'),
      defaultActivitiesView: asString(u.default_activities_view ?? u.defaultActivitiesView, 'list'),
    };
  }

  private sanitizeProfilePatch(body: Record<string, unknown>) {
    const patch: Record<string, string> = {};
    const textFields: Array<[apiKey: string, grpcKey: string]> = [
      ['name', 'name'],
      ['phone', 'phone'],
      ['position', 'position'],
      ['avatar', 'avatar_url'],
    ];
    for (const [apiKey, grpcKey] of textFields) {
      const value = body[apiKey];
      if (typeof value === 'string') patch[grpcKey] = value.trim();
    }

    // FR-MPROF-2/2a: validate timezone against the runtime IANA list; unknown → 400.
    const timezone = body.timezone;
    if (typeof timezone === 'string' && timezone.trim()) {
      const tz = timezone.trim();
      if (!AuthController.isValidTimezone(tz)) {
        throw new BadRequestException('INVALID_TIMEZONE');
      }
      patch.timezone = tz;
    }

    const language = body.language;
    if (typeof language === 'string' && AuthController.PROFILE_ENUM.language.has(language)) {
      patch.language = language;
    }

    const dateFormat = body.dateFormat;
    if (typeof dateFormat === 'string' && AuthController.PROFILE_ENUM.dateFormat.has(dateFormat)) {
      patch.date_format = dateFormat;
    }

    const timeFormat = body.timeFormat;
    if (typeof timeFormat === 'string' && AuthController.PROFILE_ENUM.timeFormat.has(timeFormat)) {
      patch.time_format = timeFormat;
    }

    const thousandsSeparator = body.thousandsSeparator;
    if (
      typeof thousandsSeparator === 'string' &&
      AuthController.PROFILE_ENUM.thousandsSeparator.has(thousandsSeparator)
    ) {
      patch.thousands_separator = thousandsSeparator;
    }

    const defaultDealsView = body.defaultDealsView;
    if (
      typeof defaultDealsView === 'string' &&
      AuthController.PROFILE_ENUM.defaultDealsView.has(defaultDealsView)
    ) {
      patch.default_deals_view = defaultDealsView;
    }

    const defaultActivitiesView = body.defaultActivitiesView;
    if (
      typeof defaultActivitiesView === 'string' &&
      AuthController.PROFILE_ENUM.defaultActivitiesView.has(defaultActivitiesView)
    ) {
      patch.default_activities_view = defaultActivitiesView;
    }

    return patch;
  }

  /**
   * Detect a safe raster image by magic bytes (BR-MPROF-4). Returns the canonical
   * Content-Type or `null` if it's not an allowed raster (SVG/active content fail).
   */
  /** Canonical IANA tz list from the Node runtime (FR-MPROF-2a). */
  private static readonly IANA_TIMEZONES: Set<string> = (() => {
    try {
      const sv = (Intl as unknown as { supportedValuesOf?: (k: string) => string[] })
        .supportedValuesOf;
      if (typeof sv === 'function') return new Set(sv('timeZone'));
    } catch {
      /* fall through */
    }
    return new Set<string>();
  })();

  private static isValidTimezone(tz: string): boolean {
    if (AuthController.IANA_TIMEZONES.size > 0) return AuthController.IANA_TIMEZONES.has(tz);
    // Fallback when supportedValuesOf is unavailable: probe via Intl.
    try {
      new Intl.DateTimeFormat('en-US', { timeZone: tz });
      return true;
    } catch {
      return false;
    }
  }

  private static readonly MFA_RATE = {
    maxAttempts: 20,
    lockMs: 15 * 60_000,
    windowMs: 15 * 60_000,
  };

  /** Public mail-initiating routes — throttle by IP (+ email when present). */
  private static readonly MAIL_RATE = {
    maxAttempts: 10,
    lockMs: 15 * 60_000,
    windowMs: 15 * 60_000,
  };

  private assertMailRateLimit(scope: string, ip: string, email: string): void {
    const keys = rateLimitKeys(email ? `email:${email}` : undefined, ip, scope);
    for (const key of keys) {
      gatewayAuthRateLimiter.assertNotLocked(key);
    }
  }

  private recordMailRateLimit(scope: string, ip: string, email: string): void {
    const keys = rateLimitKeys(email ? `email:${email}` : undefined, ip, scope);
    for (const key of keys) {
      gatewayAuthRateLimiter.recordFailure(key, AuthController.MAIL_RATE);
    }
  }

  private assertMfaRateLimit(ip: string, preauthId: string): void {
    for (const key of [`mfa-verify:ip:${ip || 'unknown'}`, `mfa-verify:preauth:${preauthId}`]) {
      gatewayAuthRateLimiter.assertNotLocked(key);
    }
  }

  private recordMfaFailure(ip: string, preauthId: string): void {
    for (const key of [`mfa-verify:ip:${ip || 'unknown'}`, `mfa-verify:preauth:${preauthId}`]) {
      gatewayAuthRateLimiter.recordFailure(key, AuthController.MFA_RATE);
    }
  }

  private static sniffRasterImage(buf: Buffer): string | null {
    if (buf.length < 12) return null;
    // PNG: 89 50 4E 47 0D 0A 1A 0A
    if (
      buf[0] === 0x89 &&
      buf[1] === 0x50 &&
      buf[2] === 0x4e &&
      buf[3] === 0x47 &&
      buf[4] === 0x0d &&
      buf[5] === 0x0a &&
      buf[6] === 0x1a &&
      buf[7] === 0x0a
    ) {
      return 'image/png';
    }
    // JPEG: FF D8 FF
    if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
    // GIF: "GIF87a" / "GIF89a"
    if (
      buf.slice(0, 6).toString('ascii') === 'GIF87a' ||
      buf.slice(0, 6).toString('ascii') === 'GIF89a'
    ) {
      return 'image/gif';
    }
    // WEBP: "RIFF"...."WEBP"
    if (
      buf.slice(0, 4).toString('ascii') === 'RIFF' &&
      buf.slice(8, 12).toString('ascii') === 'WEBP'
    ) {
      return 'image/webp';
    }
    return null;
  }

  /** gRPC-js отдаёт camelCase (accessToken), proto — snake_case. */
  private accessTokenFromGrpc(res: Record<string, unknown>): string {
    const t = res.access_token ?? res.accessToken;
    return typeof t === 'string' ? t : '';
  }

  private mfaRequiredFromGrpc(res: Record<string, unknown>): boolean {
    return Boolean(res.mfa_required ?? res.mfaRequired);
  }

  private preauthIdFromGrpc(res: Record<string, unknown>): string {
    const v = res.preauth_id ?? res.preauthId;
    return typeof v === 'string' ? v : '';
  }

  private expiresInFromGrpc(res: Record<string, unknown>): string | undefined {
    const v = res.expires_in ?? res.expiresIn;
    return typeof v === 'string' ? v : undefined;
  }

  private maxAgeFromExpiresIn(s: string): number {
    const m = s.match(/^(\d+)(d|h|m|s)?$/);
    if (!m) return 24 * 60 * 60;
    const n = parseInt(m[1], 10);
    const unit = m[2] ?? 's';
    if (unit === 'd') return n * 24 * 60 * 60;
    if (unit === 'h') return n * 60 * 60;
    if (unit === 'm') return n * 60;
    return n;
  }

  private setAccessCookie(reply: FastifyReply, token: string, expiresIn?: string): void {
    const maxAge = this.maxAgeFromExpiresIn(expiresIn ?? process.env.JWT_EXPIRE ?? '24h');
    reply.header(
      'Set-Cookie',
      `${AuthController.ACCESS_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${
        process.env.NODE_ENV === 'production' ? '; Secure' : ''
      }`,
    );
  }

  @Public()
  @Post('login')
  @ApiTags('Auth')
  @ApiOperation({ summary: 'Login via auth service gRPC' })
  @ApiBody({ type: LoginDto })
  async login(
    @Body() body: LoginDto,
    @Req() req: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    const identifier = (body.email?.trim() || body.login?.trim()) ?? '';
    if (!identifier) throw new BadRequestException('email or login required');
    const md = this.outboundMeta.build(req as FastifyRequest & { user?: { userId?: string } });
    try {
      const grpcRes = (await grpcBffCall(
        this.authGrpc.login(
          { identifier, password: body.password, ...this.deviceContext(req) },
          md,
        ) as never,
      )) as Record<string, unknown> & {
        user?: { id: string; login: string; email: string; name: string };
      };
      // 2FA: first factor accepted but no JWT yet — client must POST /api/auth/2fa/verify.
      if (this.mfaRequiredFromGrpc(grpcRes)) {
        return { mfaRequired: true, preauthId: this.preauthIdFromGrpc(grpcRes) };
      }
      const token = this.accessTokenFromGrpc(grpcRes);
      this.setAccessCookie(reply, token, this.expiresInFromGrpc(grpcRes));
      const user = this.mapGrpcUserToApiUser(grpcRes.user as Record<string, unknown>);
      void this.gatewayEvents.authLogin(user.userId, {
        method: 'password',
        ip: this.deviceContext(req).ip,
      });
      return {
        token,
        user,
      };
    } catch (e) {
      const code = (e as { code?: unknown })?.code;
      if (code === GrpcStatus.UNAUTHENTICATED || code === GrpcStatus.PERMISSION_DENIED) {
        void this.gatewayEvents.authLoginFailed({
          method: 'password',
          ip: this.deviceContext(req).ip,
          identifier,
        });
      }
      this.mapAuthGrpcError(e, 'login', 'Invalid credentials');
    }
  }

  @Public()
  @Post('2fa/verify')
  @ApiTags('Auth')
  @ApiOperation({ summary: 'Submit the second factor (TOTP/backup code) for a login challenge' })
  async verifyMfa(
    @Body() body: { preauthId?: string; code?: string; backupCode?: string },
    @Req() req: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    const preauthId = (body.preauthId ?? '').trim();
    // The backup-code screen posts `{ backupCode }`; the domain verifyMfa treats
    // the single `code` field as TOTP-or-backup-code, so accept both here — else
    // logging in with a backup code always 400'd "code is required" (BX-07).
    const code = (body.code ?? body.backupCode ?? '').trim();
    if (!preauthId || !code) throw new BadRequestException('preauthId and code are required');
    const ip = this.clientIp(req);
    this.assertMfaRateLimit(ip, preauthId);
    const md = this.outboundMeta.build(req as FastifyRequest & { user?: { userId?: string } });
    try {
      const grpcRes = (await grpcBffCall(
        this.authGrpc.verifyMfa(
          { preauth_id: preauthId, code, ...this.deviceContext(req) },
          md,
        ) as never,
      )) as Record<string, unknown> & {
        user?: { id: string; login: string; email: string; name: string };
      };
      for (const key of [`mfa-verify:ip:${ip || 'unknown'}`, `mfa-verify:preauth:${preauthId}`]) {
        gatewayAuthRateLimiter.reset(key);
      }
      const token = this.accessTokenFromGrpc(grpcRes);
      this.setAccessCookie(reply, token, this.expiresInFromGrpc(grpcRes));
      const user = this.mapGrpcUserToApiUser(grpcRes.user as Record<string, unknown>);
      void this.gatewayEvents.authLogin(user.userId, {
        method: 'mfa',
        ip,
      });
      return {
        token,
        user,
      };
    } catch (e) {
      const codeNum = (e as { code?: unknown })?.code;
      if (
        codeNum === GrpcStatus.UNAUTHENTICATED ||
        codeNum === GrpcStatus.PERMISSION_DENIED ||
        codeNum === GrpcStatus.INVALID_ARGUMENT
      ) {
        this.recordMfaFailure(ip, preauthId);
      }
      this.mapAuthGrpcError(e, 'verifyMfa', 'Invalid 2FA code');
    }
  }

  @Public()
  @Post('register')
  @ApiTags('Auth')
  @ApiOperation({ summary: 'Register (disabled — the box stand is invite-only)' })
  register(): never {
    // the box stand is invite-only single-tenant: the only legitimate account-creation
    // paths are first-run bootstrap (creates the master admin) and invite-accept.
    // Public self-registration is permanently disabled — this route exists solely
    // to answer a direct-API bypass with a clean 403 instead of auto-provisioning
    // an orgless account that could then create a second organization.
    throw new ForbiddenException({ code: 'REGISTRATION_DISABLED' });
  }

  /**
   * Translate a gRPC ServiceError from the auth domain into the correct HTTP
   * exception, logging the underlying cause. Callers pass a `unauthorizedMessage`
   * used ONLY for genuine auth failures (bad credentials / MFA) — infrastructure
   * outages must NOT masquerade as "invalid credentials".
   */
  private mapAuthGrpcError(e: unknown, context: string, unauthorizedMessage: string): never {
    const code = (e as { code?: unknown })?.code;
    const detail = this.authErrorMessage(e, unauthorizedMessage);
    this.logger.warn(`${context} failed: grpcCode=${String(code)} detail=${detail}`);
    switch (code) {
      case GrpcStatus.ALREADY_EXISTS:
      case GrpcStatus.ABORTED:
        throw new ConflictException(detail);
      case GrpcStatus.INVALID_ARGUMENT:
      case GrpcStatus.FAILED_PRECONDITION:
      case GrpcStatus.OUT_OF_RANGE:
        throw new BadRequestException(detail);
      case GrpcStatus.RESOURCE_EXHAUSTED:
        // Brute-force lockout from the auth domain — surface a 429 with a retry
        // hint, NOT a 401 that would masquerade as "invalid credentials".
        throw new HttpException(
          detail && detail !== unauthorizedMessage
            ? detail
            : 'Too many attempts — the account is temporarily locked. Try again later.',
          HttpStatus.TOO_MANY_REQUESTS,
        );
      case GrpcStatus.UNAVAILABLE:
      case GrpcStatus.DEADLINE_EXCEEDED:
        throw new ServiceUnavailableException('Authentication service is temporarily unavailable');
      case GrpcStatus.UNAUTHENTICATED:
      case GrpcStatus.PERMISSION_DENIED:
      case GrpcStatus.NOT_FOUND:
        throw new UnauthorizedException(unauthorizedMessage);
      default:
        // grpcBffCall wraps a deadline miss as GatewayTimeoutException (504) with
        // no numeric gRPC code. Never remap upstream 5xx into 401 — FE session
        // probe treats 401 as «logged out» and 5xx as a transient infra error.
        if (e instanceof HttpException && e.getStatus() >= 500) throw e;
        throw new UnauthorizedException(unauthorizedMessage);
    }
  }

  @Public()
  @AuthPublicThrottle({
    ...AUTH_PUBLIC_HOURLY_5,
    extraKeys: (req) => {
      const email = String(req.body?.email ?? '')
        .trim()
        .toLowerCase();
      return email ? [`mail-forgot:email:${email}`] : [];
    },
  })
  @Post('forgot-password')
  @ApiTags('Auth')
  @ApiOperation({ summary: 'Request a password-reset email (generic response)' })
  async forgotPassword(@Body() body: { email?: string }, @Req() req: FastifyRequest) {
    const email = (body.email ?? '').trim().toLowerCase();
    const ip = this.clientIp(req);
    this.assertMailRateLimit('mail-forgot', ip, email);
    const md = this.outboundMeta.build(req as FastifyRequest & { user?: { userId?: string } });
    if (email) {
      try {
        const r = (await grpcBffCall(
          this.authGrpc.requestPasswordReset({ email }, md) as never,
        )) as Record<string, unknown>;
        const found = Boolean(r.found);
        const resetToken = (r.reset_token ?? r.resetToken) as string | undefined;
        const name = (r.name as string | undefined) ?? '';
        if (found && resetToken) {
          await this.sendAuthEmail(md, {
            to: (r.email as string) || email,
            kind: 'password_reset',
            actionUrl: `${this.appBaseUrl()}/auth/reset-password/${resetToken}`,
            userName: name,
          });
        }
      } catch {
        // never reveal failures — always answer generically below.
      }
    }
    this.recordMailRateLimit('mail-forgot', ip, email);
    // Generic 200 whether or not the account exists (no enumeration).
    return { ok: true };
  }

  @Public()
  @Post('reset-password')
  @ApiTags('Auth')
  @ApiOperation({ summary: 'Set a new password using a reset token' })
  async resetPassword(
    @Body() body: { token?: string; password?: string },
    @Req() req: FastifyRequest,
  ) {
    const token = (body.token ?? '').trim();
    const password = body.password ?? '';
    if (!token) throw new BadRequestException('token is required');
    if (!password) throw new BadRequestException('password is required');
    const md = this.outboundMeta.build(req as FastifyRequest & { user?: { userId?: string } });
    try {
      await grpcBffCall(
        this.authGrpc.resetPassword({ token, new_password: password }, md) as never,
      );
      return { ok: true };
    } catch (e) {
      const msg = this.authErrorMessage(e, 'Reset failed');
      if (/\bTOKEN_USED\b/.test(msg) || /\bTOKEN_EXPIRED\b/.test(msg)) {
        throw new HttpException(
          {
            code: /\bTOKEN_USED\b/.test(msg) ? 'TOKEN_USED' : 'TOKEN_EXPIRED',
            message: msg,
          },
          HttpStatus.GONE,
        );
      }
      throw new BadRequestException(msg);
    }
  }

  @Public()
  @AuthPublicThrottle({
    ...AUTH_PUBLIC_HOURLY_5,
    extraKeys: (req) => {
      const email = String(req.body?.email ?? '')
        .trim()
        .toLowerCase();
      return email ? [`mail-verify:email:${email}`] : [];
    },
  })
  @Post('verify-email/request')
  @ApiTags('Auth')
  @ApiOperation({ summary: 'Resend the email-verification letter (generic response)' })
  async requestEmailVerification(@Body() body: { email?: string }, @Req() req: FastifyRequest) {
    const email = (body.email ?? '').trim().toLowerCase();
    const ip = this.clientIp(req);
    this.assertMailRateLimit('mail-verify', ip, email);
    const md = this.outboundMeta.build(req as FastifyRequest & { user?: { userId?: string } });
    if (email) {
      try {
        const r = (await grpcBffCall(
          this.authGrpc.requestEmailVerification({ email }, md) as never,
        )) as Record<string, unknown>;
        const verifyToken = (r.verify_token ?? r.verifyToken) as string | undefined;
        if (Boolean(r.found) && !(r.already_verified ?? r.alreadyVerified) && verifyToken) {
          await this.sendAuthEmail(md, {
            to: (r.email as string) || email,
            kind: 'verify_email',
            actionUrl: `${this.appBaseUrl()}/auth/verify-email/${verifyToken}`,
            userName: (r.name as string | undefined) ?? '',
          });
        }
      } catch {
        // generic response regardless.
      }
    }
    this.recordMailRateLimit('mail-verify', ip, email);
    return { ok: true };
  }

  @Public()
  @Post('verify-email/confirm')
  @ApiTags('Auth')
  @ApiOperation({ summary: 'Confirm an email address using a verification token' })
  async confirmEmailVerification(@Body() body: { token?: string }, @Req() req: FastifyRequest) {
    const token = (body.token ?? '').trim();
    if (!token) throw new BadRequestException('token is required');
    const md = this.outboundMeta.build(req as FastifyRequest & { user?: { userId?: string } });
    try {
      await grpcBffCall(this.authGrpc.confirmEmailVerification({ token }, md) as never);
      return { emailVerified: true };
    } catch (e) {
      throw new BadRequestException(this.authErrorMessage(e, 'Verification failed'));
    }
  }

  /** Surface the domain error code (TOKEN_EXPIRED / WEAK_PASSWORD / …) to the client. */
  private authErrorMessage(e: unknown, fallback: string): string {
    const msg =
      (e as { details?: string; message?: string })?.details ??
      (e as { message?: string })?.message;
    return typeof msg === 'string' && msg ? msg : fallback;
  }

  @Public()
  @Post('logout')
  @ApiTags('Auth')
  @ApiOperation({ summary: 'Logout (revokes the calling session + clears cookie)' })
  async logout(@Req() req: FastifyRequest, @Res({ passthrough: true }) res: FastifyReply) {
    // Revoke the calling session in the auth domain so its jti enters the
    // deny-list (BR-AUTH-09). Best-effort: a missing/invalid token still clears
    // the cookie and returns 200 (logout is idempotent and never errors).
    const token = this.extractToken(req);
    if (token) {
      try {
        const claims = this.jwt.verify<{ sub?: string; jti?: string }>(token);
        if (claims?.sub && claims?.jti) {
          const md = this.outboundMeta.build({
            headers: req.headers as Record<string, unknown>,
            user: { userId: claims.sub, sessionId: claims.jti },
          } as unknown as FastifyRequest & { user: { userId: string } });
          void this.gatewayEvents.authLogout(claims.sub, claims.jti);
          await grpcBffCall(
            this.authGrpc.logout({ user_id: claims.sub, session_id: claims.jti }, md) as never,
          ).catch(() => undefined);
        }
      } catch {
        // expired/invalid token — nothing to revoke; still clear the cookie.
      }
    }
    res.header(
      'Set-Cookie',
      `${AuthController.ACCESS_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${
        process.env.NODE_ENV === 'production' ? '; Secure' : ''
      }`,
    );
    return { ok: true };
  }

  @Get('me')
  @ApiTags('Profile')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Current user' })
  async me(@Request() req: { user: { userId: string }; headers: Record<string, unknown> }) {
    const md = this.outboundMeta.build(
      req as unknown as FastifyRequest & { user: { userId: string } },
    );
    try {
      const u = (await grpcBffCall(
        this.authGrpc.me({ user_id: req.user.userId }, md) as never,
      )) as Record<string, unknown>;
      // Hydrate the caller's projects (fixes empty user.projects on the FE). Best-effort:
      // control being unavailable degrades to `projects: []` without failing /me.
      const projects = await this.listMyProjectsSafe(req.user.userId, md);
      return {
        user: {
          ...this.mapGrpcUserToApiUser(u),
          twoFactorEnabled: Boolean(u.two_factor_enabled ?? u.twoFactorEnabled),
          require2fa: Boolean(u.require2fa),
          backupCodesRemaining: Number(u.backup_codes_remaining ?? u.backupCodesRemaining ?? 0),
          // FR-MPROF-18: pending email change survives a reload on the profile screen.
          pendingEmail: ((u.pending_email ?? u.pendingEmail) as string) || null,
          projects,
        },
      };
    } catch (e) {
      // JwtAuthGuard already rejected unauthenticated callers — a failure here is
      // upstream (auth/control outage), not «logged out». Never mask 5xx as 200+null.
      this.mapAuthGrpcError(e, 'GET /me', 'Session invalid');
    }
  }

  @Patch('me')
  @ApiTags('Profile')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Update current user profile' })
  async updateMe(
    @Request() req: { user: { userId: string }; headers: Record<string, unknown> },
    @Body() body: Record<string, unknown>,
  ) {
    const md = this.outboundMeta.build(
      req as unknown as FastifyRequest & { user: { userId: string } },
    );
    const payload = this.sanitizeProfilePatch(body);
    const u = (await grpcBffCall(
      this.authGrpc.updateMe({ user_id: req.user.userId, ...payload }, md) as never,
    )) as Record<string, unknown>;
    return { user: this.mapGrpcUserToApiUser(u) };
  }

  @Post('me/avatar')
  @ApiTags('Profile')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Upload avatar image to S3 and save URL' })
  async uploadAvatar(
    @Req() req: FastifyRequest & { user: { userId: string }; file: () => Promise<unknown> },
  ) {
    const file = (await req.file()) as
      | {
          filename: string;
          mimetype: string;
          file: Readable;
          toBuffer: () => Promise<Buffer>;
        }
      | undefined;
    if (!file) {
      throw new BadRequestException('file is required');
    }
    const buffer = await file.toBuffer();
    // FR-MPROF-5 / BR-MPROF-4: do not trust the client Content-Type. Sniff magic
    // bytes, deny SVG/active content, enforce a 5 MB limit.
    const MAX_AVATAR_BYTES = 5 * 1024 * 1024;
    if (buffer.length > MAX_AVATAR_BYTES) {
      throw new BadRequestException('avatar must be ≤ 5 MB');
    }
    const sniffed = AuthController.sniffRasterImage(buffer);
    if (!sniffed) {
      throw new BadRequestException('only PNG/JPEG/WEBP/GIF raster images are allowed');
    }
    const contentType = sniffed;
    const uploaded = await this.avatarStorage.uploadAvatar({
      userId: req.user.userId,
      fileName: file.filename,
      contentType,
      buffer,
    });

    const md = this.outboundMeta.build(req as FastifyRequest & { user: { userId: string } });
    const u = (await grpcBffCall(
      this.authGrpc.updateMe(
        { user_id: req.user.userId, avatar_url: uploaded.publicUrl },
        md,
      ) as never,
    )) as Record<string, unknown>;
    return {
      user: this.mapGrpcUserToApiUser(u),
      avatarUrl: uploaded.publicUrl,
      objectKey: uploaded.objectKey,
    };
  }
}
