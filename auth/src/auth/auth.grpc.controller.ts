import { Controller } from '@nestjs/common';
import { GrpcMethod, RpcException } from '@nestjs/microservices';
import { status } from '@grpc/grpc-js';
import type { Metadata } from '@grpc/grpc-js';
import { GW_METADATA } from '@fairflow/shared';
import { AuthService } from './auth.service';
import { ProfileService } from './profile.service';
import { AppError } from '../common/errors';
import { RequireKeyScopes } from '../common/require-key-scopes.decorator';

/**
 * Resolve the authenticated subject. The trusted source is the `x-user-id`
 * gateway metadata; the body `user_id` is only a hint. If both are present and
 * disagree → PERMISSION_DENIED (closes the IDOR on Me/UpdateMe — auth.md §6.9).
 */
function resolveSubject(metadata: Metadata | undefined, bodyUserId?: string): string {
  const raw = metadata?.get(GW_METADATA.USER_ID)?.[0];
  const metaUserId = (typeof raw === 'string' ? raw : (raw?.toString?.() ?? '')).trim();
  const body = (bodyUserId ?? '').trim();
  if (metaUserId) {
    if (body && body !== metaUserId) {
      throw new RpcException({
        code: status.PERMISSION_DENIED,
        message: 'subject mismatch',
      });
    }
    return metaUserId;
  }
  // No metadata (e.g. legacy caller) — fall back to body for backward compat.
  return body;
}

@Controller()
export class AuthGrpcController {
  constructor(
    private readonly auth: AuthService,
    private readonly profile: ProfileService,
  ) {}

  /** Map a profile to the snake_case wire shape the keepCase loader expects. */
  private toWireUser(u: {
    id: string;
    login: string;
    email: string;
    name: string | null;
    avatarUrl?: string | null;
    phone?: string | null;
    position?: string | null;
    language?: string;
    timezone?: string;
    dateFormat?: string;
    timeFormat?: string;
    thousandsSeparator?: string;
    defaultDealsView?: string;
    defaultActivitiesView?: string;
  }) {
    return {
      id: u.id,
      login: u.login,
      email: u.email,
      name: u.name ?? '',
      avatar_url: u.avatarUrl ?? '',
      phone: u.phone ?? '',
      position: u.position ?? '',
      language: u.language ?? 'ru',
      timezone: u.timezone ?? 'Europe/Moscow',
      date_format: u.dateFormat ?? 'DD.MM.YYYY',
      time_format: u.timeFormat ?? '24h',
      thousands_separator: u.thousandsSeparator ?? 'space',
      default_deals_view: u.defaultDealsView ?? 'kanban',
      default_activities_view: u.defaultActivitiesView ?? 'list',
    };
  }

  /** Shape an AuthResult into the snake_case LoginResponse the wire expects. */
  private toLoginResponse(r: {
    accessToken: string;
    expiresIn: string;
    user: {
      id: string;
      login: string;
      email: string;
      name: string | null;
      avatarUrl?: string | null;
      phone?: string | null;
      position?: string | null;
      language?: string;
      timezone?: string;
      dateFormat?: string;
      timeFormat?: string;
      thousandsSeparator?: string;
      defaultDealsView?: string;
      defaultActivitiesView?: string;
    };
  }) {
    return {
      access_token: r.accessToken,
      expires_in: r.expiresIn,
      mfa_required: false,
      preauth_id: '',
      user: this.toWireUser(r.user),
    };
  }

  @GrpcMethod('AuthGrpc', 'Login')
  async login(data: {
    identifier: string;
    password: string;
    device_label?: string;
    deviceLabel?: string;
    ip?: string;
  }) {
    let r;
    try {
      r = await this.auth.loginWithMfa(data.identifier ?? '', data.password ?? '', {
        deviceLabel: data.device_label ?? data.deviceLabel,
        ip: data.ip,
      });
    } catch (e) {
      // Surface the brute-force lockout distinctly; everything else is a generic 401.
      if (e instanceof AppError && e.errorCode === 'rateLimit') {
        throw new RpcException({ code: status.RESOURCE_EXHAUSTED, message: e.message });
      }
      throw new RpcException({ code: status.UNAUTHENTICATED, message: 'Invalid credentials' });
    }
    if (r.mfaRequired) {
      // No JWT yet — the client must finish with VerifyMfa(preauthId, code).
      return {
        access_token: '',
        expires_in: '',
        mfa_required: true,
        preauth_id: r.preauthId ?? '',
      };
    }
    return this.toLoginResponse(r.auth!);
  }

  @GrpcMethod('AuthGrpc', 'VerifyMfa')
  async verifyMfa(data: {
    preauth_id?: string;
    preauthId?: string;
    code?: string;
    device_label?: string;
    deviceLabel?: string;
    ip?: string;
  }) {
    try {
      const auth = await this.auth.verifyMfa(
        data.preauth_id ?? data.preauthId ?? '',
        data.code ?? '',
        { deviceLabel: data.device_label ?? data.deviceLabel, ip: data.ip },
      );
      return this.toLoginResponse(auth);
    } catch (e) {
      const msg = (e as Error).message;
      const code =
        msg === 'CHALLENGE_EXPIRED'
          ? status.FAILED_PRECONDITION
          : msg === 'INVALID_TOTP'
            ? status.INVALID_ARGUMENT
            : status.UNAUTHENTICATED;
      throw new RpcException({ code, message: msg });
    }
  }

  @GrpcMethod('AuthGrpc', 'OauthLogin')
  async oauthLogin(data: {
    provider?: string;
    external_id?: string;
    externalId?: string;
    email?: string;
    name?: string;
    avatar_url?: string;
    avatarUrl?: string;
    device_label?: string;
    deviceLabel?: string;
    ip?: string;
  }) {
    try {
      const r = await this.auth.oauthLogin(
        {
          provider: data.provider ?? '',
          externalId: data.external_id ?? data.externalId ?? '',
          email: data.email ?? '',
          name: data.name,
          avatarUrl: data.avatar_url ?? data.avatarUrl,
        },
        { deviceLabel: data.device_label ?? data.deviceLabel, ip: data.ip },
      );
      if (r.mfaRequired) {
        return {
          access_token: '',
          expires_in: '',
          mfa_required: true,
          preauth_id: r.preauthId ?? '',
        };
      }
      return this.toLoginResponse(r.auth!);
    } catch (e) {
      throw new RpcException({
        code: status.INVALID_ARGUMENT,
        message: (e as Error).message,
      });
    }
  }

  @GrpcMethod('AuthGrpc', 'Register')
  async register(data: {
    user_name?: string;
    userName?: string;
    email: string;
    password: string;
    device_label?: string;
    deviceLabel?: string;
    ip?: string;
  }) {
    try {
      const r = await this.auth.register(
        // The gRPC server decodes inbound fields to camelCase (no keepCase), so the
        // gateway's snake_case `user_name` arrives as `userName` — accept both.
        data.user_name ?? data.userName ?? '',
        data.email ?? '',
        data.password ?? '',
        { deviceLabel: data.device_label ?? data.deviceLabel, ip: data.ip },
      );
      return {
        access_token: r.accessToken,
        expires_in: r.expiresIn,
        user: this.toWireUser(r.user),
      };
    } catch (e) {
      const msg = (e as Error).message;
      throw new RpcException({
        code: msg.includes('exists') ? status.ALREADY_EXISTS : status.INVALID_ARGUMENT,
        message: msg,
      });
    }
  }

  @GrpcMethod('AuthGrpc', 'ProvisionUser')
  async provisionUser(data: { email?: string; name?: string; password?: string }) {
    try {
      const { user, created } = await this.auth.provisionUser(
        data.email ?? '',
        data.name,
        data.password ?? '',
      );
      return { user: this.toWireUser(user), created };
    } catch (e) {
      throw new RpcException({
        code: status.INVALID_ARGUMENT,
        message: (e as Error).message,
      });
    }
  }

  @GrpcMethod('AuthGrpc', 'GetUserByEmail')
  async getUserByEmail(data: { email?: string }) {
    const u = await this.auth.getUserByEmail(data.email ?? '');
    if (!u) return { found: false };
    return { found: true, user: this.toWireUser(u) };
  }

  @GrpcMethod('AuthGrpc', 'Me')
  async me(data: { user_id?: string; userId?: string }, metadata?: Metadata) {
    const userId = resolveSubject(metadata, data.user_id ?? data.userId);
    if (!userId) {
      throw new RpcException({ code: status.UNAUTHENTICATED, message: 'Missing user id' });
    }
    const u = await this.auth.me(userId);
    if (!u) throw new RpcException({ code: status.NOT_FOUND, message: 'User not found' });
    const tfa = await this.auth.me2faStatus(userId);
    return {
      ...this.toWireUser(u),
      // FR-MPROF-18: the profile screen needs the pending change after reload.
      pending_email: await this.profile.getPendingEmail(userId),
      two_factor_enabled: tfa.twoFactorEnabled,
      require2fa: tfa.require2fa,
      backup_codes_remaining: tfa.backupCodesRemaining,
    };
  }

  @GrpcMethod('AuthGrpc', 'UpdateMe')
  async updateMe(
    data: {
      user_id?: string;
      userId?: string;
      name?: string;
      avatar_url?: string;
      avatarUrl?: string;
      phone?: string;
      position?: string;
      language?: string;
      timezone?: string;
      date_format?: string;
      dateFormat?: string;
      time_format?: string;
      timeFormat?: string;
      thousands_separator?: string;
      thousandsSeparator?: string;
      default_deals_view?: string;
      defaultDealsView?: string;
      default_activities_view?: string;
      defaultActivitiesView?: string;
    },
    metadata?: Metadata,
  ) {
    const userId = resolveSubject(metadata, data.user_id ?? data.userId);
    if (!userId) {
      throw new RpcException({ code: status.UNAUTHENTICATED, message: 'Missing user id' });
    }
    const u = await this.auth.updateMe(userId, {
      name: data.name,
      avatarUrl: data.avatar_url ?? data.avatarUrl,
      phone: data.phone,
      position: data.position,
      language: data.language,
      timezone: data.timezone,
      dateFormat: data.date_format ?? data.dateFormat,
      timeFormat: data.time_format ?? data.timeFormat,
      thousandsSeparator: data.thousands_separator ?? data.thousandsSeparator,
      defaultDealsView: data.default_deals_view ?? data.defaultDealsView,
      defaultActivitiesView: data.default_activities_view ?? data.defaultActivitiesView,
    });
    if (!u) throw new RpcException({ code: status.NOT_FOUND, message: 'User not found' });
    return this.toWireUser(u);
  }

  @GrpcMethod('AuthGrpc', 'Logout')
  async logout(
    data: { user_id?: string; userId?: string; session_id?: string; sessionId?: string },
    metadata?: Metadata,
  ) {
    const userId = resolveSubject(metadata, data.user_id ?? data.userId);
    // session_id comes from the gateway (the JWT jti of the calling session).
    const sessionId =
      (data.session_id ?? data.sessionId ?? '').trim() ||
      (metadata?.get(GW_METADATA.SESSION_ID)?.[0]?.toString?.() ?? '');
    if (userId && sessionId) await this.auth.logout(userId, sessionId);
    return {};
  }

  /** JTI deny-list check for the gateway PEP (BR-AUTH-09 / FR-MPROF-17a). */
  @GrpcMethod('AuthGrpc', 'ValidateSession')
  async validateSession(
    data: { user_id?: string; userId?: string; session_id?: string; sessionId?: string },
    metadata?: Metadata,
  ) {
    const userId = resolveSubject(metadata, data.user_id ?? data.userId);
    const sessionId =
      (data.session_id ?? data.sessionId ?? '').trim() ||
      (metadata?.get(GW_METADATA.SESSION_ID)?.[0]?.toString?.() ?? '');
    const check = await this.auth.checkSession(userId, sessionId);
    return { valid: check.valid, reason: check.reason ?? '' };
  }

  /**
   * Internal directory lookup for other services. Returns PII (name/email/login),
   * so it requires a service key carrying `gateway:invoke` (gateway BFF) OR
   * `internal:user-directory` (the notification/control s2s consumers, scoped down
   * so a leaked consumer key is NOT a master gateway key).
   *
   * Fail-closed by default (FR-AUTH-400). Set `REQUIRE_KEY_FOR_RESOLVE_USERS=false`
   * only as a staged-rollout escape hatch.
   */
  @RequireKeyScopes({
    scopes: ['gateway:invoke', 'internal:user-directory'],
    softEnforceEnv: 'REQUIRE_KEY_FOR_RESOLVE_USERS',
  })
  @GrpcMethod('UserDirectoryGrpc', 'ResolveUsers')
  async resolveUsers(data: { ids?: string[] }) {
    const users = await this.auth.resolveUsers(data.ids ?? []);
    return {
      users: users.map((u) => ({
        id: u.id,
        name: u.name,
        email: u.email,
        login: u.login,
        avatar_url: u.avatarUrl,
        position: u.position,
      })),
    };
  }

  /**
   * Internal s2s cascade: bulk-revoke every live session of the given users
   * (control's org-deactivation, FR-MORG-43). Same scope contract as
   * ResolveUsers — a service key with `internal:user-directory` (or the gateway
   * master key). Returns how many session rows were revoked.
   */
  @RequireKeyScopes({
    scopes: ['gateway:invoke', 'internal:user-directory'],
    softEnforceEnv: 'REQUIRE_KEY_FOR_RESOLVE_USERS',
  })
  @GrpcMethod('UserDirectoryGrpc', 'RevokeUserSessions')
  async revokeUserSessions(data: { user_ids?: string[]; userIds?: string[] }) {
    const revoked = await this.profile.revokeAllSessionsForUsers(
      data.user_ids ?? data.userIds ?? [],
    );
    return { revoked_count: revoked };
  }

  @GrpcMethod('AuthGrpc', 'ListUsers')
  async listUsers(data: {
    skip?: number;
    take?: number;
    login_filter?: string;
    loginFilter?: string;
    is_active?: boolean;
    isActive?: boolean;
  }) {
    const skip = data.skip ?? 0;
    const take = data.take ?? 25;
    const login = data.login_filter ?? data.loginFilter;
    const isActive =
      data.is_active !== undefined
        ? data.is_active
        : data.isActive !== undefined
          ? data.isActive
          : undefined;
    const r = await this.auth.listUsers({ skip, take, login, isActive });
    return {
      list: r.list.map((u) => ({
        id: u.id,
        login: u.login,
        email: u.email,
        name: u.name ?? '',
        is_active: u.isActive,
        created_at: u.createdAt.toISOString(),
      })),
      total: r.total,
    };
  }

  // --- profile-module TO-BE (subject from x-user-id metadata; never from body) ---

  @GrpcMethod('AuthGrpc', 'ChangePassword')
  async changePassword(
    data: {
      user_id?: string;
      userId?: string;
      current_password?: string;
      currentPassword?: string;
      new_password?: string;
      newPassword?: string;
      current_session_id?: string;
      currentSessionId?: string;
    },
    metadata?: Metadata,
  ) {
    const userId = resolveSubject(metadata, data.user_id ?? data.userId);
    await this.profile.changePassword(
      userId,
      data.current_password ?? data.currentPassword ?? '',
      data.new_password ?? data.newPassword ?? '',
      data.current_session_id ?? data.currentSessionId ?? '',
    );
    return {};
  }

  @GrpcMethod('AuthGrpc', 'RequestEmailChange')
  async requestEmailChange(
    data: {
      user_id?: string;
      userId?: string;
      new_email?: string;
      newEmail?: string;
      current_password?: string;
      currentPassword?: string;
    },
    metadata?: Metadata,
  ) {
    const userId = resolveSubject(metadata, data.user_id ?? data.userId);
    const r = await this.profile.requestEmailChange(
      userId,
      data.new_email ?? data.newEmail ?? '',
      data.current_password ?? data.currentPassword ?? '',
    );
    return {
      confirm_token: r.confirmToken,
      current_email: r.currentEmail,
      cancel_token: r.cancelToken,
    };
  }

  @GrpcMethod('AuthGrpc', 'CancelEmailChange')
  async cancelEmailChange(data: { token?: string }) {
    await this.profile.cancelEmailChange(data.token ?? '');
    return {};
  }

  @GrpcMethod('AuthGrpc', 'CancelMyEmailChange')
  async cancelMyEmailChange(data: { user_id?: string; userId?: string }, metadata?: Metadata) {
    const userId = resolveSubject(metadata, data.user_id ?? data.userId);
    if (!userId) {
      throw new RpcException({ code: status.UNAUTHENTICATED, message: 'Missing user id' });
    }
    await this.profile.cancelMyEmailChange(userId);
    return {};
  }

  @GrpcMethod('AuthGrpc', 'ConfirmEmailChange')
  async confirmEmailChange(data: { token?: string }) {
    const userId = await this.profile.confirmEmailChange(data.token ?? '');
    const u = await this.auth.me(userId);
    if (!u) throw new RpcException({ code: status.NOT_FOUND, message: 'User not found' });
    return this.toWireUser(u);
  }

  // --- password recovery / email verification (auth.md FR-AUTH-4/5) ---
  // Called by the gateway BFF only (service key required). Responses are
  // non-enumerating; the gateway turns them into a generic client answer.

  @GrpcMethod('AuthGrpc', 'RequestPasswordReset')
  async requestPasswordReset(data: { email?: string }) {
    const r = await this.auth.requestPasswordReset(data.email ?? '');
    return { found: r.found, reset_token: r.resetToken, email: r.email, name: r.name };
  }

  @GrpcMethod('AuthGrpc', 'ResetPassword')
  async resetPassword(data: { token?: string; new_password?: string; newPassword?: string }) {
    await this.auth.resetPassword(data.token ?? '', data.new_password ?? data.newPassword ?? '');
    return {};
  }

  @GrpcMethod('AuthGrpc', 'RequestEmailVerification')
  async requestEmailVerification(data: { user_id?: string; userId?: string; email?: string }) {
    const r = await this.auth.requestEmailVerification({
      userId: data.user_id ?? data.userId ?? undefined,
      email: data.email ?? undefined,
    });
    return {
      found: r.found,
      already_verified: r.alreadyVerified,
      verify_token: r.verifyToken,
      email: r.email,
      name: r.name,
    };
  }

  @GrpcMethod('AuthGrpc', 'ConfirmEmailVerification')
  async confirmEmailVerification(data: { token?: string }) {
    const userId = await this.auth.confirmEmailVerification(data.token ?? '');
    return { user_id: userId };
  }

  @GrpcMethod('AuthGrpc', 'Init2fa')
  async init2fa(
    data: {
      user_id?: string;
      userId?: string;
      current_password?: string;
      currentPassword?: string;
    },
    metadata?: Metadata,
  ) {
    const userId = resolveSubject(metadata, data.user_id ?? data.userId);
    const r = await this.profile.init2fa(
      userId,
      data.current_password ?? data.currentPassword ?? '',
    );
    return { otpauth_uri: r.otpauthUri, secret: r.secret };
  }

  @GrpcMethod('AuthGrpc', 'Enable2fa')
  async enable2fa(
    data: { user_id?: string; userId?: string; totp_code?: string; totpCode?: string },
    metadata?: Metadata,
  ) {
    const userId = resolveSubject(metadata, data.user_id ?? data.userId);
    const codes = await this.profile.enable2fa(userId, data.totp_code ?? data.totpCode ?? '');
    return { backup_codes: codes };
  }

  @GrpcMethod('AuthGrpc', 'Disable2fa')
  async disable2fa(
    data: {
      user_id?: string;
      userId?: string;
      current_password?: string;
      currentPassword?: string;
      totp_code?: string;
      totpCode?: string;
    },
    metadata?: Metadata,
  ) {
    const userId = resolveSubject(metadata, data.user_id ?? data.userId);
    await this.profile.disable2fa(
      userId,
      data.current_password ?? data.currentPassword ?? '',
      data.totp_code ?? data.totpCode ?? '',
    );
    return {};
  }

  @GrpcMethod('AuthGrpc', 'RegenBackupCodes')
  async regenBackupCodes(
    data: {
      user_id?: string;
      userId?: string;
      current_password?: string;
      currentPassword?: string;
      totp_code?: string;
      totpCode?: string;
    },
    metadata?: Metadata,
  ) {
    const userId = resolveSubject(metadata, data.user_id ?? data.userId);
    const codes = await this.profile.regenBackupCodes(
      userId,
      data.current_password ?? data.currentPassword ?? '',
      data.totp_code ?? data.totpCode ?? '',
    );
    return { backup_codes: codes };
  }

  @GrpcMethod('AuthGrpc', 'ListSessions')
  async listSessions(
    data: { user_id?: string; userId?: string; current_token_id?: string; currentTokenId?: string },
    metadata?: Metadata,
  ) {
    const userId = resolveSubject(metadata, data.user_id ?? data.userId);
    const sessions = await this.profile.listSessions(
      userId,
      data.current_token_id ?? data.currentTokenId ?? '',
    );
    return {
      sessions: sessions.map((s) => ({
        id: s.id,
        device_label: s.deviceLabel,
        ip: s.ip,
        last_seen_at: s.lastSeenAt,
        created_at: s.createdAt,
        is_current: s.isCurrent,
      })),
    };
  }

  @GrpcMethod('AuthGrpc', 'RevokeSession')
  async revokeSession(
    data: {
      user_id?: string;
      userId?: string;
      session_id?: string;
      sessionId?: string;
      current_token_id?: string;
      currentTokenId?: string;
    },
    metadata?: Metadata,
  ) {
    const userId = resolveSubject(metadata, data.user_id ?? data.userId);
    await this.profile.revokeSession(
      userId,
      data.session_id ?? data.sessionId ?? '',
      data.current_token_id ?? data.currentTokenId ?? '',
    );
    return {};
  }

  @GrpcMethod('AuthGrpc', 'RevokeOtherSessions')
  async revokeOtherSessions(
    data: { user_id?: string; userId?: string; current_token_id?: string; currentTokenId?: string },
    metadata?: Metadata,
  ) {
    const userId = resolveSubject(metadata, data.user_id ?? data.userId);
    const revoked = await this.profile.revokeOtherSessions(
      userId,
      data.current_token_id ?? data.currentTokenId ?? '',
    );
    return { revoked };
  }

  @GrpcMethod('AuthGrpc', 'GetUserProfileForViewer')
  async getUserProfileForViewer(data: {
    target_id?: string;
    targetId?: string;
    viewer_context?: {
      project_role?: string;
      projectRole?: string;
      platform_role?: string;
      platformRole?: string;
      project_id?: string;
      projectId?: string;
    };
    viewerContext?: {
      project_role?: string;
      projectRole?: string;
      platform_role?: string;
      platformRole?: string;
      project_id?: string;
      projectId?: string;
    };
  }) {
    const targetId = data.target_id ?? data.targetId ?? '';
    if (!targetId) {
      throw new RpcException({ code: status.INVALID_ARGUMENT, message: 'target id required' });
    }
    const vc = data.viewer_context ?? data.viewerContext ?? {};
    const projected = await this.profile.getUserProfileForViewer(targetId, {
      projectRole: vc.project_role ?? vc.projectRole,
      platformRole: vc.platform_role ?? vc.platformRole,
      projectId: vc.project_id ?? vc.projectId,
    });
    return projected;
  }
}
