import { Injectable } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcryptjs';
import { RpcException } from '@nestjs/microservices';
import { status } from '@grpc/grpc-js';
import { newEntityId } from '@fairflow/shared';
import { PrismaService } from '../prisma/prisma.service';
import { ProfileEventsService } from './profile-events.service';
import { SessionDenyPushService } from './session-deny-push.service';
import {
  buildOtpauthUri,
  decryptSecret,
  encryptSecret,
  generateBackupCodes,
  generateBase32Secret,
  verifyTotp,
} from './totp.util';
import { profileRevokeToReason } from './session-revoke-reason';
import { purposeSecret } from './purpose-secret.util';
import { Require2faPolicyService } from './require2fa-policy.service';

/** Password policy (FR-MPROF-6 / INV-3): ≥8 chars, not equal to current. */
const MIN_PASSWORD = 8;
const BACKUP_CODE_COUNT = 10;
/** Email-change confirm token TTL (≤1h, identity-auth/TZ.md). */
const EMAIL_CHANGE_TTL = '1h';

function rpc(code: number, message: string): RpcException {
  return new RpcException({ code, message });
}

export interface ViewerContext {
  projectRole?: string;
  platformRole?: string;
  projectId?: string;
}

@Injectable()
export class ProfileService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
    private readonly events: ProfileEventsService,
    private readonly denyPush: SessionDenyPushService,
    private readonly require2faPolicy: Require2faPolicyService,
  ) {}

  // --- password ---

  /** FR-MPROF-6/7: verify current, set new (bcrypt), revoke all other sessions. */
  async changePassword(
    userId: string,
    currentPassword: string,
    newPassword: string,
    currentSessionId: string,
  ): Promise<void> {
    const user = await this.prisma.user.findFirst({
      where: { id: userId, isActive: true },
      select: { id: true, passwordHash: true },
    });
    if (!user) throw rpc(status.NOT_FOUND, 'User not found');
    if (!(await bcrypt.compare(currentPassword, user.passwordHash))) {
      throw rpc(status.PERMISSION_DENIED, 'INVALID_CREDENTIALS'); // wrong current → 403
    }
    if (!newPassword || newPassword.length < MIN_PASSWORD) {
      throw rpc(status.INVALID_ARGUMENT, 'WEAK_PASSWORD');
    }
    if (await bcrypt.compare(newPassword, user.passwordHash)) {
      throw rpc(status.INVALID_ARGUMENT, 'WEAK_PASSWORD'); // == current
    }
    const passwordHash = await bcrypt.hash(newPassword, 10);
    await this.prisma.user.update({
      where: { id: userId },
      data: { passwordHash, passwordChangedAt: new Date() },
    });
    const revoked = await this.revokeOtherSessions(userId, currentSessionId, 'password_change');
    this.events.passwordChanged(userId, revoked);
  }

  // --- email change ---

  async requestEmailChange(
    userId: string,
    newEmail: string,
    currentPassword: string,
  ): Promise<{ confirmToken: string; currentEmail: string; cancelToken: string }> {
    const emailNorm = (newEmail ?? '').trim().toLowerCase();
    if (!emailNorm || !emailNorm.includes('@')) throw rpc(status.INVALID_ARGUMENT, 'invalid email');
    const user = await this.prisma.user.findFirst({
      where: { id: userId, isActive: true },
      select: { id: true, passwordHash: true, email: true },
    });
    if (!user) throw rpc(status.NOT_FOUND, 'User not found');
    if (!(await bcrypt.compare(currentPassword, user.passwordHash))) {
      throw rpc(status.PERMISSION_DENIED, 'INVALID_CREDENTIALS');
    }
    // Generic EMAIL_TAKEN without revealing the owner (BR-MPROF-19, FR-MPROF-19).
    const taken = await this.prisma.user.findFirst({
      where: { email: emailNorm, id: { not: userId } },
      select: { id: true },
    });
    if (taken) throw rpc(status.ALREADY_EXISTS, 'EMAIL_TAKEN');

    await this.prisma.user.update({ where: { id: userId }, data: { pendingEmail: emailNorm } });
    // Self-contained one-shot confirm token (no extra table); delivery is notification's job.
    const confirmToken = this.jwt.sign(
      { sub: userId, ec: emailNorm, kind: 'email_change' },
      { secret: purposeSecret('email_change'), expiresIn: EMAIL_CHANGE_TTL },
    );
    const cancelToken = this.jwt.sign(
      { sub: userId, ec: emailNorm, kind: 'email_change_cancel' },
      { secret: purposeSecret('email_change_cancel'), expiresIn: EMAIL_CHANGE_TTL },
    );
    this.events.emailChangeRequested(userId);
    return { confirmToken, currentEmail: user.email, cancelToken };
  }

  async cancelEmailChange(token: string): Promise<void> {
    let claims: { sub?: string; ec?: string; kind?: string };
    try {
      claims = this.jwt.verify(token, { secret: purposeSecret('email_change_cancel') });
    } catch {
      throw rpc(status.FAILED_PRECONDITION, 'TOKEN_EXPIRED');
    }
    if (claims.kind !== 'email_change_cancel' || !claims.sub || !claims.ec) {
      throw rpc(status.INVALID_ARGUMENT, 'invalid token');
    }
    const user = await this.prisma.user.findFirst({
      where: { id: claims.sub, isActive: true },
      select: { id: true, pendingEmail: true },
    });
    if (!user || user.pendingEmail !== claims.ec) {
      throw rpc(status.FAILED_PRECONDITION, 'TOKEN_EXPIRED');
    }
    await this.prisma.user.update({
      where: { id: claims.sub },
      data: { pendingEmail: null },
    });
  }

  /** Pending (unconfirmed) email change for Me (FR-MPROF-18); '' when none. */
  async getPendingEmail(userId: string): Promise<string> {
    const user = await this.prisma.user.findFirst({
      where: { id: userId, isActive: true },
      select: { pendingEmail: true },
    });
    return user?.pendingEmail ?? '';
  }

  /**
   * Self-service cancel from the profile screen (FR-MPROF-18): the authenticated
   * subject drops its own pending change — no token needed, idempotent.
   */
  async cancelMyEmailChange(userId: string): Promise<void> {
    const user = await this.prisma.user.findFirst({
      where: { id: userId, isActive: true },
      select: { id: true, pendingEmail: true },
    });
    if (!user) throw rpc(status.NOT_FOUND, 'User not found');
    if (!user.pendingEmail) return; // idempotent (NFR-MPROF-4 style)
    await this.prisma.user.update({
      where: { id: userId },
      data: { pendingEmail: null },
    });
  }

  async confirmEmailChange(token: string): Promise<string> {
    let claims: { sub?: string; ec?: string; kind?: string };
    try {
      claims = this.jwt.verify(token, { secret: purposeSecret('email_change') });
    } catch {
      throw rpc(status.FAILED_PRECONDITION, 'TOKEN_EXPIRED'); // 410-class
    }
    if (claims.kind !== 'email_change' || !claims.sub || !claims.ec) {
      throw rpc(status.INVALID_ARGUMENT, 'invalid token');
    }
    const user = await this.prisma.user.findFirst({
      where: { id: claims.sub, isActive: true },
      select: { id: true, pendingEmail: true },
    });
    if (!user || user.pendingEmail !== claims.ec) {
      throw rpc(status.FAILED_PRECONDITION, 'TOKEN_EXPIRED'); // already used / changed (idempotent)
    }
    // Re-check uniqueness at confirm time (race window).
    const taken = await this.prisma.user.findFirst({
      where: { email: claims.ec, id: { not: claims.sub } },
      select: { id: true },
    });
    if (taken) throw rpc(status.ALREADY_EXISTS, 'EMAIL_TAKEN');
    await this.prisma.user.update({
      where: { id: claims.sub },
      data: { email: claims.ec, pendingEmail: null, emailVerified: true },
    });
    this.events.emailChanged(claims.sub);
    return claims.sub;
  }

  // --- 2FA ---

  async init2fa(
    userId: string,
    currentPassword: string,
  ): Promise<{ otpauthUri: string; secret: string }> {
    const user = await this.prisma.user.findFirst({
      where: { id: userId, isActive: true },
      select: { id: true, email: true, passwordHash: true, twoFactorEnabled: true },
    });
    if (!user) throw rpc(status.NOT_FOUND, 'User not found');
    if (!(await bcrypt.compare(currentPassword, user.passwordHash))) {
      throw rpc(status.PERMISSION_DENIED, 'INVALID_CREDENTIALS');
    }
    if (user.twoFactorEnabled) throw rpc(status.FAILED_PRECONDITION, 'ALREADY_ENABLED');
    const secret = generateBase32Secret();
    await this.prisma.user.update({
      where: { id: userId },
      data: { twoFactorPendingSecret: encryptSecret(secret) },
    });
    return { otpauthUri: buildOtpauthUri(secret, user.email), secret };
  }

  async enable2fa(userId: string, totpCode: string): Promise<string[]> {
    const user = await this.prisma.user.findFirst({
      where: { id: userId, isActive: true },
      select: { id: true, twoFactorPendingSecret: true, twoFactorEnabled: true },
    });
    if (!user) throw rpc(status.NOT_FOUND, 'User not found');
    if (user.twoFactorEnabled) throw rpc(status.FAILED_PRECONDITION, 'ALREADY_ENABLED');
    if (!user.twoFactorPendingSecret) throw rpc(status.FAILED_PRECONDITION, 'NO_PENDING_2FA');
    const secret = decryptSecret(user.twoFactorPendingSecret);
    if (!verifyTotp(secret, totpCode)) throw rpc(status.INVALID_ARGUMENT, 'INVALID_TOTP');

    const codes = generateBackupCodes(BACKUP_CODE_COUNT);
    // Hash the backup codes BEFORE opening the transaction. bcryptjs is a
    // pure-JS, CPU-bound hash; doing 10 of them inside an interactive tx held
    // the tx (and a row lock) open for ~1s+ and, on a slow single-core box,
    // could blow Prisma's 5s tx timeout → a raw error surfaced to the client as
    // a 500 "Internal error" while enabling 2FA (BX-07).
    const rows = await this.hashBackupCodes(userId, codes);
    await this.prisma.$transaction(async (tx) => {
      await tx.user.update({
        where: { id: userId },
        data: {
          twoFactorEnabled: true,
          twoFactorSecret: user.twoFactorPendingSecret,
          twoFactorPendingSecret: null,
          twoFactorEnabledAt: new Date(),
        },
      });
      await tx.userBackupCode.deleteMany({ where: { userId } });
      await tx.userBackupCode.createMany({ data: rows });
    });
    this.events.twoFactorEnabled(userId);
    return codes;
  }

  /** Rejects with TWO_FACTOR_REQUIRED_BY_POLICY when Require2faPolicyService is on. */
  async disable2fa(userId: string, currentPassword: string, totpCode: string): Promise<void> {
    const user = await this.prisma.user.findFirst({
      where: { id: userId, isActive: true },
      select: { id: true, passwordHash: true, twoFactorEnabled: true, twoFactorSecret: true },
    });
    if (!user) throw rpc(status.NOT_FOUND, 'User not found');
    if (!user.twoFactorEnabled || !user.twoFactorSecret) {
      throw rpc(status.FAILED_PRECONDITION, 'NOT_ENABLED');
    }
    if (!(await bcrypt.compare(currentPassword, user.passwordHash))) {
      throw rpc(status.PERMISSION_DENIED, 'INVALID_CREDENTIALS');
    }
    if (!verifyTotp(decryptSecret(user.twoFactorSecret), totpCode)) {
      throw rpc(status.INVALID_ARGUMENT, 'INVALID_TOTP');
    }
    if (this.require2faPolicy.isRequired()) {
      throw rpc(status.ABORTED, 'TWO_FACTOR_REQUIRED_BY_POLICY');
    }
    await this.prisma.$transaction(async (tx) => {
      await tx.user.update({
        where: { id: userId },
        data: { twoFactorEnabled: false, twoFactorSecret: null, twoFactorPendingSecret: null },
      });
      await tx.userBackupCode.deleteMany({ where: { userId } });
    });
    this.events.twoFactorDisabled(userId);
  }

  async regenBackupCodes(
    userId: string,
    currentPassword: string,
    totpCode: string,
  ): Promise<string[]> {
    const user = await this.prisma.user.findFirst({
      where: { id: userId, isActive: true },
      select: { id: true, passwordHash: true, twoFactorEnabled: true, twoFactorSecret: true },
    });
    if (!user) throw rpc(status.NOT_FOUND, 'User not found');
    if (!user.twoFactorEnabled || !user.twoFactorSecret) {
      throw rpc(status.FAILED_PRECONDITION, 'NOT_ENABLED');
    }
    if (!(await bcrypt.compare(currentPassword, user.passwordHash))) {
      throw rpc(status.PERMISSION_DENIED, 'INVALID_CREDENTIALS');
    }
    if (!verifyTotp(decryptSecret(user.twoFactorSecret), totpCode)) {
      throw rpc(status.INVALID_ARGUMENT, 'INVALID_TOTP');
    }
    const codes = generateBackupCodes(BACKUP_CODE_COUNT);
    // Hash outside the tx (see enable2fa) — keeps the tx short and off the CPU.
    const rows = await this.hashBackupCodes(userId, codes);
    await this.prisma.$transaction(async (tx) => {
      await tx.userBackupCode.deleteMany({ where: { userId } });
      await tx.userBackupCode.createMany({ data: rows });
    });
    return codes;
  }

  /** Pre-hash backup codes into insert rows (bcrypt is CPU-bound — never do this inside a tx). */
  private async hashBackupCodes(
    userId: string,
    codes: string[],
  ): Promise<Array<{ id: string; userId: string; codeHash: string }>> {
    return Promise.all(
      codes.map(async (code) => ({
        id: newEntityId(),
        userId,
        codeHash: await bcrypt.hash(code, 10),
      })),
    );
  }

  // --- sessions ---

  async listSessions(
    userId: string,
    currentTokenId: string,
  ): Promise<
    Array<{
      id: string;
      deviceLabel: string;
      ip: string;
      lastSeenAt: string;
      createdAt: string;
      isCurrent: boolean;
    }>
  > {
    const now = new Date();
    const rows = await this.prisma.session.findMany({
      where: { userId, revokedAt: null, expiresAt: { gt: now } },
      orderBy: { lastSeenAt: 'desc' },
      select: {
        id: true,
        tokenId: true,
        deviceLabel: true,
        ip: true,
        lastSeenAt: true,
        createdAt: true,
      },
    });
    return rows.map((r) => ({
      id: r.id,
      deviceLabel: r.deviceLabel ?? 'Unknown device',
      ip: r.ip ?? '',
      lastSeenAt: (r.lastSeenAt ?? r.createdAt).toISOString(),
      createdAt: r.createdAt.toISOString(),
      isCurrent: !!currentTokenId && r.tokenId === currentTokenId,
    }));
  }

  async revokeSession(userId: string, sessionId: string, currentTokenId: string): Promise<void> {
    const session = await this.prisma.session.findFirst({
      where: { id: sessionId, userId },
      select: { id: true, tokenId: true, revokedAt: true },
    });
    if (!session) throw rpc(status.NOT_FOUND, 'Session not found'); // foreign/unknown → 404
    if (currentTokenId && session.tokenId === currentTokenId) {
      throw rpc(status.FAILED_PRECONDITION, 'CANNOT_REVOKE_CURRENT_SESSION');
    }
    if (!session.revokedAt) {
      const reason = profileRevokeToReason('manual');
      await this.prisma.session.update({
        where: { id: sessionId },
        data: { revokedAt: new Date(), revokedReason: reason },
      });
      const row = await this.prisma.session.findUnique({
        where: { id: sessionId },
        select: { tokenId: true, expiresAt: true },
      });
      if (row?.tokenId) await this.denyPush.pushDenied(row.tokenId, row.expiresAt, reason);
      this.events.sessionRevoked(userId, sessionId, 'manual');
    }
  }

  async revokeOtherSessions(
    userId: string,
    currentTokenId: string,
    reason: 'manual' | 'password_change' | 'revoke_others' = 'revoke_others',
  ): Promise<number> {
    const where = {
      userId,
      revokedAt: null,
      ...(currentTokenId ? { tokenId: { not: currentTokenId } } : {}),
    };
    const victims = await this.prisma.session.findMany({
      where,
      select: { id: true, tokenId: true, expiresAt: true },
    });
    if (victims.length === 0) return 0;
    const revokeReason = profileRevokeToReason(reason);
    await this.prisma.session.updateMany({
      where,
      data: { revokedAt: new Date(), revokedReason: revokeReason },
    });
    await this.denyPush.pushDeniedMany(victims, revokeReason);
    for (const v of victims) this.events.sessionRevoked(userId, v.id, reason);
    return victims.length;
  }

  /**
   * Bulk-revoke EVERY live session of the given users (internal cascade, e.g.
   * org deactivation FR-MORG-43). Unlike {@link revokeOtherSessions} no session
   * is preserved — the caller is a service, not one of these users. Marking
   * `revokedAt` makes ValidateSession (gateway JTI deny-list) deny their tokens
   * on the next request. Returns the number of session rows revoked.
   */
  async revokeAllSessionsForUsers(userIds: string[]): Promise<number> {
    const ids = [...new Set((userIds ?? []).map((s) => (s ?? '').trim()).filter(Boolean))];
    if (ids.length === 0) return 0;
    const where = { userId: { in: ids }, revokedAt: null };
    const victims = await this.prisma.session.findMany({
      where,
      select: { id: true, userId: true, tokenId: true, expiresAt: true },
    });
    if (victims.length === 0) return 0;
    const revokeReason = profileRevokeToReason('org_deactivated');
    await this.prisma.session.updateMany({
      where,
      data: { revokedAt: new Date(), revokedReason: revokeReason },
    });
    await this.denyPush.pushDeniedMany(victims, revokeReason);
    for (const v of victims) this.events.sessionRevoked(v.userId, v.id, 'org_deactivated');
    return victims.length;
  }

  // --- foreign profile projection (FR-MPROF-25/25a) ---

  /**
   * Field-projected foreign profile. Projection runs in the source (auth);
   * fields without the right never leave the domain (BR-MPROF-23/24).
   * Matrix §19 (profile-module/TZ.md §7.3). The greatest applicable role wins.
   */
  async getUserProfileForViewer(targetId: string, viewer: ViewerContext) {
    const isSystem =
      viewer.platformRole === 'platform_owner' || viewer.platformRole === 'platform_admin';
    // Project-roles MUST carry a project context (FR-MPROF-26a). System roles are cross-project.
    if (!isSystem && !viewer.projectId) {
      throw rpc(status.INVALID_ARGUMENT, 'project context required');
    }
    const target = await this.prisma.user.findFirst({
      where: { id: targetId, isActive: true },
      select: {
        id: true,
        login: true,
        email: true,
        name: true,
        avatarUrl: true,
        phone: true,
        position: true,
        language: true,
        timezone: true,
        dateFormat: true,
        timeFormat: true,
        thousandsSeparator: true,
        defaultDealsView: true,
        defaultActivitiesView: true,
      },
    });
    // Existence not revealed beyond projection scope (404, FR-MPROF-26a).
    // NOTE: cross-project membership check (T ∈ viewer.projectId) is resolved on the
    // gateway/control side via viewer_context; auth never calls control (no ring dep).
    if (!target) throw rpc(status.NOT_FOUND, 'User not found');

    const level = this.resolveVisibilityLevel(viewer.projectRole, viewer.platformRole);
    // Base (Viewer): name + avatar only.
    // snake_case keys — the User proto is served with the keepCase loader.
    const projected: Record<string, unknown> = {
      id: target.id,
      login: '',
      email: '',
      name: target.name ?? '',
      avatar_url: target.avatarUrl ?? '',
      phone: '',
      position: '',
      language: '',
      timezone: '',
      date_format: '',
      time_format: '',
      thousands_separator: '',
      default_deals_view: '',
      default_activities_view: '',
      last_active_at: '',
    };
    if (level >= 1) {
      // Member / Manager: + position (department/role added by gateway from control)
      projected.position = target.position ?? '';
    }
    if (level >= 2) {
      // Project Admin: + email + last activity (OQ-MPROF-NEW-2)
      projected.email = target.email;
      projected.last_active_at = await this.resolveLastActiveAt(targetId);
    }
    if (level >= 3) {
      // Platform Owner/Admin: full identity (login + regional)
      projected.login = target.login;
      projected.phone = target.phone ?? '';
      projected.language = target.language;
      projected.timezone = target.timezone;
      projected.date_format = target.dateFormat;
      projected.time_format = target.timeFormat;
      projected.thousands_separator = target.thousandsSeparator;
      projected.default_deals_view = target.defaultDealsView;
      projected.default_activities_view = target.defaultActivitiesView;
    }
    return projected;
  }

  /** max(Session.lastSeenAt) for live sessions — foreign-profile level ≥2 only. */
  private async resolveLastActiveAt(userId: string): Promise<string> {
    const agg = await this.prisma.session.aggregate({
      where: { userId, revokedAt: null },
      _max: { lastSeenAt: true },
    });
    const ts = agg._max.lastSeenAt;
    return ts ? ts.toISOString() : '';
  }

  /** Map roles → §19 visibility level. 0=Viewer,1=Member/Manager,2=ProjectAdmin,3=Platform. */
  private resolveVisibilityLevel(projectRole?: string, platformRole?: string): number {
    if (platformRole === 'platform_owner' || platformRole === 'platform_admin') return 3;
    switch ((projectRole ?? '').toLowerCase()) {
      // 'owner' is the top PROJECT role (shared PROJECT_ROLES) — §19 "greatest
      // applicable role wins", so it can never see LESS than its own admin.
      case 'owner':
      case 'project_admin':
      case 'admin':
        return 2;
      case 'member':
      case 'manager':
        return 1;
      default:
        return 0; // viewer / unknown
    }
  }
}
