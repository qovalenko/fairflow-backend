import {
  Controller,
  Post,
  Get,
  Delete,
  Body,
  Param,
  UseGuards,
  Request,
  Inject,
  OnModuleInit,
  Logger,
} from '@nestjs/common';
import { ClientGrpcProxy } from '@nestjs/microservices';
import { grpcBffCall } from '../bff/grpc-bff-call';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import type { FastifyRequest } from 'fastify';
import { JwtAuthGuard } from './guards/jwt-auth.guard';
import { GatewayOutboundMetadataService } from '../bff/gateway-outbound-metadata.service';
import { gatewayAuthRateLimiter, rateLimitKeys } from './auth-rate-limit';

type ReqUser = {
  user: { userId: string; sessionId?: string };
  headers: Record<string, unknown>;
  /** Fastify socket ip — the fallback when TRUST_PROXY is off (same as auth.controller). */
  ip?: string;
};

const SENSITIVE_RATE = { maxAttempts: 10, lockMs: 15 * 60_000, windowMs: 15 * 60_000 };

function clientIp(req: ReqUser): string {
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

/**
 * Profile-module account & session BFF (profile-module/TZ.md §6.1).
 * All endpoints are self-scoped (no x-project-id) — the trusted subject is the
 * JWT user propagated as x-user-id metadata; the auth domain ignores any body
 * user_id that disagrees (IDOR closed in auth, auth.md §6.9).
 *
 * Sensitive ops are REST POST only — eases audit/rate-limit (§6.2).
 */
@Controller('auth/me')
export class ProfileController implements OnModuleInit {
  private readonly logger = new Logger(ProfileController.name);
  private grpc!: {
    changePassword: (x: unknown, m?: unknown) => unknown;
    requestEmailChange: (x: unknown, m?: unknown) => unknown;
    cancelMyEmailChange: (x: unknown, m?: unknown) => unknown;
    init2fa: (x: unknown, m?: unknown) => unknown;
    enable2fa: (x: unknown, m?: unknown) => unknown;
    disable2fa: (x: unknown, m?: unknown) => unknown;
    regenBackupCodes: (x: unknown, m?: unknown) => unknown;
    listSessions: (x: unknown, m?: unknown) => unknown;
    revokeSession: (x: unknown, m?: unknown) => unknown;
    revokeOtherSessions: (x: unknown, m?: unknown) => unknown;
  };
  private notificationGrpc!: {
    sendTransactionalEmail: (x: unknown, m?: unknown) => unknown;
  };

  constructor(
    @Inject('AUTH_GRPC') private readonly authClient: ClientGrpcProxy,
    @Inject('NOTIFICATION_GRPC') private readonly notificationClient: ClientGrpcProxy,
    private readonly outboundMeta: GatewayOutboundMetadataService,
  ) {}

  onModuleInit() {
    this.grpc = this.authClient.getService('AuthGrpc');
    this.notificationGrpc = this.notificationClient.getService('NotificationGrpc');
  }

  private appBaseUrl(): string {
    return (process.env.APP_PUBLIC_URL ?? 'http://localhost:5173').replace(/\/+$/, '');
  }

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
      this.logger.warn(`best-effort auth email (${input.kind}) failed for ${input.to}`);
    }
  }

  private md(req: ReqUser) {
    return this.outboundMeta.build(req as unknown as FastifyRequest & { user: { userId: string } });
  }

  @Post('password')
  @ApiTags('Profile')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Change password (revokes other sessions)' })
  async changePassword(
    @Request() req: ReqUser,
    @Body() body: { currentPassword?: string; newPassword?: string },
  ) {
    const ip = clientIp(req);
    for (const key of rateLimitKeys(req.user.userId, ip, 'me-password')) {
      gatewayAuthRateLimiter.assertNotLocked(key);
    }
    try {
      await grpcBffCall(
        this.grpc.changePassword(
          {
            current_password: body.currentPassword ?? '',
            new_password: body.newPassword ?? '',
            current_session_id: req.user.sessionId ?? '',
          },
          this.md(req),
        ) as never,
      );
      for (const key of rateLimitKeys(req.user.userId, ip, 'me-password')) {
        gatewayAuthRateLimiter.reset(key);
      }
      return { ok: true };
    } catch (e) {
      for (const key of rateLimitKeys(req.user.userId, ip, 'me-password')) {
        gatewayAuthRateLimiter.recordFailure(key, SENSITIVE_RATE);
      }
      throw e;
    }
  }

  @Post('email')
  @ApiTags('Profile')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Request email change (double opt-in)' })
  async requestEmailChange(
    @Request() req: ReqUser,
    @Body() body: { newEmail?: string; currentPassword?: string },
  ) {
    const ip = clientIp(req);
    for (const key of rateLimitKeys(req.user.userId, ip, 'me-email')) {
      gatewayAuthRateLimiter.assertNotLocked(key);
    }
    const newEmail = (body.newEmail ?? '').trim().toLowerCase();
    const md = this.md(req);
    try {
      const r = (await grpcBffCall(
        this.grpc.requestEmailChange(
          { new_email: newEmail, current_password: body.currentPassword ?? '' },
          md,
        ) as never,
      )) as Record<string, unknown>;
      const confirmToken = (r.confirm_token ?? r.confirmToken) as string | undefined;
      const currentEmail = (r.current_email ?? r.currentEmail) as string | undefined;
      const cancelToken = (r.cancel_token ?? r.cancelToken) as string | undefined;
      if (newEmail && confirmToken) {
        await this.sendAuthEmail(md, {
          to: newEmail,
          kind: 'email_change',
          actionUrl: `${this.appBaseUrl()}/account/email/confirm?token=${encodeURIComponent(confirmToken)}`,
        });
      }
      if (currentEmail && cancelToken) {
        await this.sendAuthEmail(md, {
          to: currentEmail,
          kind: 'email_change_alert',
          actionUrl: `${this.appBaseUrl()}/account/email/cancel?token=${encodeURIComponent(cancelToken)}`,
        });
      }
      for (const key of rateLimitKeys(req.user.userId, ip, 'me-email')) {
        gatewayAuthRateLimiter.reset(key);
      }
      return { ok: true };
    } catch (e) {
      for (const key of rateLimitKeys(req.user.userId, ip, 'me-email')) {
        gatewayAuthRateLimiter.recordFailure(key, SENSITIVE_RATE);
      }
      throw e;
    }
  }

  @Delete('email')
  @ApiTags('Profile')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Cancel my pending email change (FR-MPROF-18)' })
  async cancelMyEmailChange(@Request() req: ReqUser) {
    await grpcBffCall(this.grpc.cancelMyEmailChange({}, this.md(req)) as never);
    return { pendingEmail: null };
  }

  @Post('2fa/init')
  @ApiTags('Profile')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Start 2FA (returns otpauth URI + secret to render QR)' })
  async init2fa(@Request() req: ReqUser, @Body() body: { currentPassword?: string }) {
    const r = (await grpcBffCall(
      this.grpc.init2fa({ current_password: body.currentPassword ?? '' }, this.md(req)) as never,
    )) as Record<string, unknown>;
    return {
      otpauthUri: (r.otpauth_uri ?? r.otpauthUri ?? '') as string,
      secret: (r.secret ?? '') as string,
    };
  }

  @Post('2fa/enable')
  @ApiTags('Profile')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Enable 2FA — returns one-time backup codes' })
  async enable2fa(@Request() req: ReqUser, @Body() body: { totpCode?: string }) {
    // 'write' deadline (15s): enable hashes 10 backup codes (bcrypt) server-side;
    // the default 5s read deadline could 504 a slow box mid-enable (BX-07).
    const r = (await grpcBffCall(
      this.grpc.enable2fa({ totp_code: body.totpCode ?? '' }, this.md(req)) as never,
      'write',
    )) as Record<string, unknown>;
    return { backupCodes: (r.backup_codes ?? r.backupCodes ?? []) as string[] };
  }

  @Post('2fa/disable')
  @ApiTags('Profile')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Disable 2FA (re-auth + TOTP)' })
  async disable2fa(
    @Request() req: ReqUser,
    @Body() body: { currentPassword?: string; totpCode?: string },
  ) {
    await grpcBffCall(
      this.grpc.disable2fa(
        { current_password: body.currentPassword ?? '', totp_code: body.totpCode ?? '' },
        this.md(req),
      ) as never,
    );
    return { ok: true };
  }

  @Post('2fa/backup-codes/regenerate')
  @ApiTags('Profile')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Regenerate backup codes (invalidates old)' })
  async regenBackupCodes(
    @Request() req: ReqUser,
    @Body() body: { currentPassword?: string; totpCode?: string },
  ) {
    const r = (await grpcBffCall(
      this.grpc.regenBackupCodes(
        {
          current_password: body.currentPassword ?? '',
          totp_code: body.totpCode ?? '',
        },
        this.md(req),
      ) as never,
      'write', // re-hashes 10 backup codes server-side — see enable2fa (BX-07).
    )) as Record<string, unknown>;
    return { backupCodes: (r.backup_codes ?? r.backupCodes ?? []) as string[] };
  }

  @Get('sessions')
  @ApiTags('Profile')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'List active sessions (current flagged)' })
  async listSessions(@Request() req: ReqUser) {
    const r = (await grpcBffCall(
      this.grpc.listSessions({ current_token_id: req.user.sessionId ?? '' }, this.md(req)) as never,
    )) as Record<string, unknown>;
    const rows = (r.sessions ?? []) as Array<Record<string, unknown>>;
    return {
      sessions: rows.map((s) => ({
        id: s.id,
        deviceLabel: s.device_label ?? s.deviceLabel ?? '',
        ip: s.ip ?? '',
        lastSeenAt: s.last_seen_at ?? s.lastSeenAt ?? '',
        createdAt: s.created_at ?? s.createdAt ?? '',
        isCurrent: Boolean(s.is_current ?? s.isCurrent),
      })),
    };
  }

  @Delete('sessions/:id')
  @ApiTags('Profile')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Revoke a session (not the current one)' })
  async revokeSession(@Request() req: ReqUser, @Param('id') id: string) {
    await grpcBffCall(
      this.grpc.revokeSession(
        { session_id: id, current_token_id: req.user.sessionId ?? '' },
        this.md(req),
      ) as never,
    );
    return { ok: true };
  }

  @Post('sessions/revoke-others')
  @ApiTags('Profile')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Revoke all sessions except the current one' })
  async revokeOthers(@Request() req: ReqUser) {
    const r = (await grpcBffCall(
      this.grpc.revokeOtherSessions(
        { current_token_id: req.user.sessionId ?? '' },
        this.md(req),
      ) as never,
    )) as Record<string, unknown>;
    return { revoked: Number(r.revoked ?? 0) };
  }
}
