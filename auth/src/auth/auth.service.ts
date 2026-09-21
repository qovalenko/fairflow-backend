import { Injectable } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { RpcException } from '@nestjs/microservices';
import { status } from '@grpc/grpc-js';
import * as bcrypt from 'bcryptjs';
import { randomUUID } from 'node:crypto';
import { newEntityId } from '@fairflow/shared';
import { PrismaService } from '../prisma/prisma.service';
import { Prisma } from '../generated/prisma';
import { AppError } from '../common/errors';
import { decryptSecret, verifyTotp } from './totp.util';
import { purposeSecret } from './purpose-secret.util';
import { SessionDenyPushService } from './session-deny-push.service';
import { Require2faPolicyService } from './require2fa-policy.service';
import { LoginAttemptStore, type LoginAttemptState } from './login-attempt-store.service';
import type { SessionRevokeReason } from './session-revoke-reason';

export type SessionCheckResult = { valid: boolean; reason?: SessionRevokeReason };

/** Prisma unique-constraint violation. */
function isUniqueViolation(e: unknown): e is Prisma.PrismaClientKnownRequestError {
  return e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002';
}

/** Which column(s) tripped the unique index (best-effort, for a precise message). */
function uniqueTarget(e: Prisma.PrismaClientKnownRequestError): string {
  const t = (e.meta as { target?: unknown } | undefined)?.target;
  return Array.isArray(t) ? t.join(',') : typeof t === 'string' ? t : '';
}

/** Minimum password length (FR-AUTH-5 / INV-3), matches profile changePassword. */
const MIN_PASSWORD = 8;
/** One-time token TTLs (purpose-scoped, signed with a derived secret). */
const PWD_RESET_TTL = '1h';
const EMAIL_VERIFY_TTL = '24h';

/** Max ids per ResolveUsers batch (anti-scrape; contract auth.md §ResolveUsers). */
const RESOLVE_USERS_MAX_BATCH = 200;

/** TTL of the 2FA pre-auth challenge — second factor must be supplied promptly. */
const PREAUTH_TTL = '5m';
/** Per-challenge 2FA failure budget before the preauth token is burned. */
const MFA_MAX_ATTEMPTS = 5;
const LOGIN_WINDOW_MS = 15 * 60_000;
const LOGIN_TRACKER_MAX = 50_000;

export interface JwtPayload {
  sub: string;
  login: string;
  /** Нормализованный email (lower case) для клиента и gateway без лишнего /me */
  email: string;
  jti: string;
}

export interface AuthResult {
  accessToken: string;
  expiresIn: string;
  user: AuthUserProfile;
}

/** Device context captured for the persisted Session (best-effort, gateway-supplied). */
export interface SessionContext {
  deviceLabel?: string;
  ip?: string;
}

/** Either a finished session, or a 2FA challenge that needs a second factor. */
export interface LoginResult {
  mfaRequired: boolean;
  /** Present only when mfaRequired — short-lived signed challenge id. */
  preauthId?: string;
  /** Present only when login completed (no 2FA / second factor passed). */
  auth?: AuthResult;
}

export interface AuthUserProfile {
  id: string;
  login: string;
  email: string;
  name: string | null;
  avatarUrl: string | null;
  phone: string | null;
  position: string | null;
  language: string;
  timezone: string;
  dateFormat: string;
  timeFormat: string;
  thousandsSeparator: string;
  defaultDealsView: string;
  defaultActivitiesView: string;
}

export interface UpdateMePayload {
  name?: string;
  avatarUrl?: string;
  phone?: string;
  position?: string;
  language?: string;
  timezone?: string;
  dateFormat?: string;
  timeFormat?: string;
  thousandsSeparator?: string;
  defaultDealsView?: string;
  defaultActivitiesView?: string;
}

@Injectable()
export class AuthService {
  /**
   * One-shot 2FA challenge tracker (TODO-006): jti of every successfully redeemed
   * preauth challenge, kept until the challenge's own exp. Per-instance best-effort,
   * same trade-off as {@link loginAttempts} (a shared store is the multi-replica TO-BE).
   */
  private readonly consumedChallenges = new Map<string, number>();

  /** Per-challenge 2FA failure counter (keyed by preauth jti). */
  private readonly mfaAttempts = new Map<string, LoginAttemptState>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly jwtService: JwtService,
    private readonly denyPush: SessionDenyPushService,
    private readonly require2faPolicy: Require2faPolicyService,
    private readonly loginAttempts: LoginAttemptStore,
  ) {}

  private loginIdKey(identifier: string): string {
    // `id:` keeps the namespace disjoint from `ip:` — otherwise a crafted
    // identifier literally equal to "ip:<addr>" could lock out that IP's logins.
    return `id:${(identifier ?? '').trim().toLowerCase()}`;
  }

  private loginIpKey(ip?: string): string | null {
    const trimmed = (ip ?? '').trim();
    return trimmed ? `ip:${trimmed}` : null;
  }

  private loginTrackKeys(idKey: string, ip?: string): string[] {
    return [idKey, this.loginIpKey(ip)].filter(Boolean) as string[];
  }

  /** Throw `rateLimit` if any tracked key is currently locked out. */
  private async assertNotLocked(idKey: string, ip?: string): Promise<void> {
    try {
      await this.loginAttempts.assertNotLocked(this.loginTrackKeys(idKey, ip));
    } catch {
      throw new AppError('rateLimit', 'Too many failed login attempts, try again later');
    }
  }

  /** Record a failed attempt on both identifier and IP keys (dual-key lockout). */
  private async registerLoginFailure(idKey: string, ip?: string): Promise<void> {
    for (const key of this.loginTrackKeys(idKey, ip)) {
      await this.loginAttempts.registerFailure(key);
    }
  }

  /** Clear counters on a successful login. */
  private async resetLoginFailures(idKey: string, ip?: string): Promise<void> {
    await this.loginAttempts.reset(this.loginTrackKeys(idKey, ip));
  }

  private sweepExpiredAttempts(tracker: Map<string, LoginAttemptState>): void {
    const now = Date.now();
    for (const [key, s] of tracker) {
      if (s.lockedUntil <= now && now - s.firstFailAt > LOGIN_WINDOW_MS) {
        tracker.delete(key);
      }
    }
  }

  private evictTrackerOverflow(tracker: Map<string, LoginAttemptState>): void {
    if (tracker.size <= LOGIN_TRACKER_MAX) return;
    this.sweepExpiredAttempts(tracker);
    while (tracker.size > LOGIN_TRACKER_MAX) {
      const oldest = tracker.keys().next().value;
      if (oldest === undefined) break;
      tracker.delete(oldest);
    }
  }

  private assertMfaNotLocked(jti: string): void {
    const s = this.mfaAttempts.get(jti);
    if (s && s.fails >= MFA_MAX_ATTEMPTS) {
      throw new AppError('auth', 'CHALLENGE_EXPIRED');
    }
  }

  private registerMfaFailure(jti: string, expSeconds?: number): void {
    const now = Date.now();
    let s = this.mfaAttempts.get(jti);
    if (!s || now - s.firstFailAt > LOGIN_WINDOW_MS) {
      s = { fails: 0, firstFailAt: now, lockedUntil: 0 };
    }
    s.fails += 1;
    this.mfaAttempts.set(jti, s);
    if (s.fails >= MFA_MAX_ATTEMPTS) {
      // Burn the challenge once the per-challenge budget is exhausted.
      this.consumedChallenges.set(jti, expSeconds ? expSeconds * 1000 : now + 5 * 60_000);
    }
    this.evictTrackerOverflow(this.mfaAttempts);
  }

  /** Вход по логину или по email (identifier — одно из двух). */
  async validateUser(identifier: string, password: string): Promise<AuthUserProfile | null> {
    const t = identifier.trim();
    if (!t) return null;
    const user = await this.prisma.user.findFirst({
      where: {
        isActive: true,
        emailVerified: true,
        OR: [{ login: t }, { email: { equals: t, mode: 'insensitive' } }],
      },
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
        passwordHash: true,
      },
    });
    if (!user || !(await bcrypt.compare(password, user.passwordHash))) return null;
    const { passwordHash: _h, ...rest } = user as typeof user & { passwordHash: string };
    return this.mapUser(rest);
  }

  async validateAndLogin(loginOrEmail: string, password: string): Promise<AuthResult> {
    const idKey = this.loginIdKey(loginOrEmail);
    await this.assertNotLocked(idKey);
    const user = await this.validateUser(loginOrEmail, password);
    if (!user) {
      await this.registerLoginFailure(idKey);
      throw new AppError('auth', 'Invalid login or password');
    }
    await this.resetLoginFailures(idKey);
    return this.issueToken(user);
  }

  /**
   * First-factor login. If the account has 2FA enabled, NO JWT is issued — a
   * short-lived signed preauth challenge is returned instead, and the caller must
   * finish with {@link verifyMfa}. Otherwise a full session is issued.
   */
  async loginWithMfa(
    loginOrEmail: string,
    password: string,
    ctx?: SessionContext,
  ): Promise<LoginResult> {
    const idKey = this.loginIdKey(loginOrEmail);
    const ip = ctx?.ip?.trim() || '';
    await this.assertNotLocked(idKey, ip);
    const user = await this.validateUser(loginOrEmail, password);
    if (!user) {
      await this.registerLoginFailure(idKey, ip);
      throw new AppError('auth', 'Invalid login or password');
    }
    await this.resetLoginFailures(idKey, ip);
    return this.startSessionOrChallenge(user.id, ctx);
  }

  /** Issue either a finished session or a 2FA challenge for an already-authenticated subject. */
  async startSessionOrChallenge(userId: string, ctx?: SessionContext): Promise<LoginResult> {
    const flags = await this.prisma.user.findFirst({
      where: { id: userId, isActive: true },
      select: { id: true, twoFactorEnabled: true },
    });
    if (!flags) throw new AppError('auth', 'Invalid login or password');
    if (!flags.twoFactorEnabled) {
      const profile = await this.me(userId);
      if (!profile) throw new AppError('auth', 'Invalid login or password');
      return { mfaRequired: false, auth: await this.issueToken(profile, ctx) };
    }
    // Purpose-scoped one-shot challenge token: signed with a DERIVED secret (never
    // the access-token key) so a leaked preauthId cannot be replayed as a Bearer
    // token on the gateway; its jti is burned on the first successful verifyMfa.
    const preauthId = this.jwtService.sign(
      { sub: userId, kind: 'mfa_challenge', jti: randomUUID() } as object,
      { secret: purposeSecret('mfa_challenge'), expiresIn: PREAUTH_TTL },
    );
    return { mfaRequired: true, preauthId };
  }

  /** Second factor: verify TOTP or a one-time backup code against the preauth challenge. */
  async verifyMfa(preauthId: string, code: string, ctx?: SessionContext): Promise<AuthResult> {
    let claims: { sub?: string; kind?: string; jti?: string; exp?: number };
    try {
      claims = this.jwtService.verify(preauthId, { secret: purposeSecret('mfa_challenge') });
    } catch {
      throw new AppError('auth', 'CHALLENGE_EXPIRED');
    }
    if (claims.kind !== 'mfa_challenge' || !claims.sub || !claims.jti) {
      throw new AppError('auth', 'INVALID_CHALLENGE');
    }
    if (this.consumedChallenges.has(claims.jti)) {
      // One-shot: a redeemed challenge can never start a second session.
      throw new AppError('auth', 'CHALLENGE_EXPIRED');
    }
    this.assertMfaNotLocked(claims.jti);
    const user = await this.prisma.user.findFirst({
      where: { id: claims.sub, isActive: true },
      select: { id: true, twoFactorEnabled: true, twoFactorSecret: true },
    });
    if (!user || !user.twoFactorEnabled || !user.twoFactorSecret) {
      throw new AppError('auth', 'INVALID_CHALLENGE');
    }
    const normalized = (code ?? '').trim();
    let ok = verifyTotp(decryptSecret(user.twoFactorSecret), normalized);
    // TOTP codes are exactly 6 digits — skip the expensive backup-code bcrypt loop.
    if (!ok && !/^\d{6}$/.test(normalized)) {
      ok = await this.consumeBackupCode(user.id, normalized);
    }
    if (!ok) {
      this.registerMfaFailure(claims.jti, claims.exp);
      throw new AppError('auth', 'INVALID_TOTP');
    }
    this.mfaAttempts.delete(claims.jti);
    this.consumeChallenge(claims.jti, claims.exp);
    const profile = await this.me(user.id);
    if (!profile) throw new AppError('auth', 'Invalid login or password');
    return this.issueToken(profile, ctx);
  }

  /** Burn a redeemed challenge jti (and sweep expired entries to bound memory). */
  private consumeChallenge(jti: string, expSeconds?: number): void {
    const now = Date.now();
    for (const [k, exp] of this.consumedChallenges) {
      if (exp <= now) this.consumedChallenges.delete(k);
    }
    // Keep the jti until the challenge itself expires (fallback: the preauth TTL).
    this.consumedChallenges.set(jti, expSeconds ? expSeconds * 1000 : now + 5 * 60_000);
  }

  /** Try to redeem a one-time backup code (hashed, single-use). Returns true on success. */
  private async consumeBackupCode(userId: string, code: string): Promise<boolean> {
    if (!/^[a-z0-9-]{4,}$/i.test(code)) return false;
    const rows = await this.prisma.userBackupCode.findMany({
      where: { userId, usedAt: null },
      select: { id: true, codeHash: true },
    });
    for (const r of rows) {
      if (await bcrypt.compare(code, r.codeHash)) {
        await this.prisma.userBackupCode.update({
          where: { id: r.id },
          data: { usedAt: new Date() },
        });
        return true;
      }
    }
    return false;
  }

  /**
   * Find-or-create a user from an external OAuth/social provider (e.g. Yandex) and
   * start a session (subject to the same 2FA challenge as password login). The
   * provider HTTP exchange happens on the gateway; here we trust the resolved
   * identity. Account is matched by email (verified by the provider).
   */
  async oauthLogin(
    input: {
      provider: string;
      externalId: string;
      email: string;
      name?: string;
      avatarUrl?: string;
    },
    ctx?: SessionContext,
  ): Promise<LoginResult> {
    const emailNorm = (input.email ?? '').trim().toLowerCase();
    if (!emailNorm || !emailNorm.includes('@')) {
      throw new AppError('auth', 'oauth: provider did not return an email');
    }
    let user = await this.prisma.user.findFirst({
      where: { email: emailNorm },
      select: { id: true, avatarUrl: true },
    });
    if (!user) {
      throw new AppError(
        'auth',
        'oauth: account not provisioned — accept your invitation or sign in with password first',
      );
    } else if (input.avatarUrl?.trim() && !user.avatarUrl) {
      await this.prisma.user.update({
        where: { id: user.id },
        data: { avatarUrl: input.avatarUrl.trim() },
      });
    }
    return this.startSessionOrChallenge(user.id, ctx);
  }

  /** 2FA status for the Me endpoint (FR-MPROF / auth.md §me). */
  async me2faStatus(
    userId: string,
  ): Promise<{ twoFactorEnabled: boolean; require2fa: boolean; backupCodesRemaining: number }> {
    const id = userId?.trim();
    if (!id) return { twoFactorEnabled: false, require2fa: false, backupCodesRemaining: 0 };
    const user = await this.prisma.user.findFirst({
      where: { id, isActive: true },
      select: { id: true, twoFactorEnabled: true },
    });
    if (!user) return { twoFactorEnabled: false, require2fa: false, backupCodesRemaining: 0 };
    const backupCodesRemaining = user.twoFactorEnabled
      ? await this.prisma.userBackupCode.count({ where: { userId: id, usedAt: null } })
      : 0;
    return {
      twoFactorEnabled: user.twoFactorEnabled,
      require2fa: this.require2faPolicy.isRequired(),
      backupCodesRemaining,
    };
  }

  /**
   * Issue a JWT and persist a {@link https://...|Session} row keyed by the token's
   * jti (BR-AUTH-07/09). The persisted session is the source of truth for the
   * jti deny-list (logout / revoke / password-change) and for ListSessions.
   * Session persistence is required: if the write fails the login must fail so
   * every issued token is revocable (FR-AUTH-110).
   */
  async issueToken(user: AuthUserProfile, ctx?: SessionContext): Promise<AuthResult> {
    const emailNorm = user.email.trim().toLowerCase();
    const jti = randomUUID();
    const payload: JwtPayload = {
      sub: user.id,
      login: user.login,
      email: emailNorm,
      jti,
    };
    const expiresInStr = process.env.JWT_EXPIRE ?? '24h';
    const expiresInSeconds = this.parseExpiresIn(expiresInStr);
    const accessToken = this.jwtService.sign(payload as object, { expiresIn: expiresInSeconds });
    const now = new Date();
    await this.prisma.session.create({
      data: {
        id: newEntityId(),
        userId: user.id,
        tokenId: jti,
        deviceLabel: ctx?.deviceLabel?.trim() || null,
        ip: ctx?.ip?.trim() || null,
        lastSeenAt: now,
        expiresAt: new Date(now.getTime() + expiresInSeconds * 1000),
      },
    });
    return {
      accessToken,
      expiresIn: expiresInStr,
      user,
    };
  }

  /**
   * Revoke the calling session (logout). Marks the Session row (matched by its
   * jti) revoked so the gateway deny-list rejects the token immediately. No-op if
   * the session is unknown/already revoked (idempotent).
   */
  async logout(userId: string, sessionId: string): Promise<void> {
    const uid = userId?.trim();
    const sid = sessionId?.trim();
    if (!uid || !sid) return;
    const session = await this.prisma.session.findFirst({
      where: { userId: uid, tokenId: sid },
      select: { expiresAt: true },
    });
    await this.prisma.session.updateMany({
      where: { userId: uid, tokenId: sid, revokedAt: null },
      data: { revokedAt: new Date(), revokedReason: 'signed_out' },
    });
    if (session) await this.denyPush.pushDenied(sid, session.expiresAt, 'signed_out');
  }

  /**
   * JTI deny-list check (BR-AUTH-09 / FR-MPROF-17a). Fail-CLOSED on the security
   * decision but fail-OPEN on infrastructure: a session that is present-and-not-
   * revoked is valid; a session that was explicitly revoked is invalid. A session
   * row that simply does not exist (token issued before session-tracking, or the
   * create above was skipped) is treated as valid — otherwise enabling the
   * deny-list would log out every legacy token at once. Revocation is the
   * authoritative negative signal. lastSeenAt is bumped opportunistically.
   */
  async isSessionValid(userId: string, sessionId: string): Promise<boolean> {
    return (await this.checkSession(userId, sessionId)).valid;
  }

  async checkSession(userId: string, sessionId: string): Promise<SessionCheckResult> {
    const uid = userId?.trim();
    const sid = sessionId?.trim();
    if (!uid || !sid) return { valid: false, reason: 'session_revoked' };
    const session = await this.prisma.session.findFirst({
      where: { userId: uid, tokenId: sid },
      select: { id: true, revokedAt: true, revokedReason: true, expiresAt: true },
    });
    if (!session) return { valid: true }; // untracked token — JWT signature/exp already verified by gateway
    if (session.revokedAt) {
      const reason = (session.revokedReason as SessionRevokeReason | null) ?? 'session_revoked';
      return { valid: false, reason };
    }
    if (session.expiresAt && session.expiresAt.getTime() <= Date.now()) {
      return { valid: false, reason: 'token_expired' };
    }
    // Opportunistic last-seen bump (don't block the request on it).
    this.prisma.session
      .update({ where: { id: session.id }, data: { lastSeenAt: new Date() } })
      .catch(() => undefined);
    return { valid: true };
  }

  private mapUser(user: {
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
  }): AuthUserProfile {
    return {
      id: user.id,
      login: user.login,
      email: user.email,
      name: user.name ?? null,
      avatarUrl: user.avatarUrl ?? null,
      phone: user.phone ?? null,
      position: user.position ?? null,
      language: user.language ?? 'ru',
      timezone: user.timezone ?? 'Europe/Moscow',
      dateFormat: user.dateFormat ?? 'DD.MM.YYYY',
      timeFormat: user.timeFormat ?? '24h',
      thousandsSeparator: user.thousandsSeparator ?? 'space',
      defaultDealsView: user.defaultDealsView ?? 'kanban',
      defaultActivitiesView: user.defaultActivitiesView ?? 'list',
    };
  }

  private parseExpiresIn(s: string): number {
    const match = s.match(/^(\d+)(d|h|m|s)?$/);
    if (!match) return 604800;
    const n = parseInt(match[1], 10);
    const unit = match[2] ?? 's';
    if (unit === 'd') return n * 86400;
    if (unit === 'h') return n * 3600;
    if (unit === 'm') return n * 60;
    return n;
  }

  async register(
    userName: string,
    email: string,
    password: string,
    ctx?: SessionContext,
  ): Promise<AuthResult> {
    const loginNorm = userName.trim();
    const emailNorm = email.trim().toLowerCase();
    if (!loginNorm || !emailNorm) throw new AppError('auth', 'login and email required');
    if (!password || password.length < MIN_PASSWORD) {
      throw new AppError('auth', 'password too short');
    }
    const exists = await this.prisma.user.findFirst({
      where: { OR: [{ email: emailNorm }, { login: loginNorm }] },
    });
    if (exists) throw new AppError('auth', 'User already exists');
    const passwordHash = await bcrypt.hash(password, 10);
    let user;
    try {
      user = await this.prisma.$transaction(
        async (tx) => {
          const count = await tx.user.count();
          if (count > 0) throw new AppError('auth', 'User already exists');
          return tx.user.create({
            data: {
              id: newEntityId(),
              login: loginNorm,
              email: emailNorm,
              passwordHash,
              name: loginNorm,
              // BOX: Register is bootstrap-only (self-signup is closed). Closed
              // circuit has no verification email — FR-AUTH-050 would otherwise
              // lock the first admin out after the bootstrap cookie expires.
              emailVerified: true,
            },
            select: AuthService.PROFILE_SELECT,
          });
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
      );
    } catch (e) {
      if (e instanceof AppError) throw e;
      // Concurrent signup slipped past the existence check above → still a dup.
      if (isUniqueViolation(e)) throw new AppError('auth', 'User already exists');
      throw e;
    }
    return this.issueToken(this.mapUser(user), ctx);
  }

  // --- password recovery / email verification (auth.md FR-AUTH-4/5) ---

  /**
   * Purpose-scoped token secret. Derived from the JWT secret so these one-time
   * tokens are signed with a DIFFERENT key than access tokens — a leaked reset /
   * verify token can never be replayed as a session bearer (and vice-versa).
   */
  private purposeSecret(kind: string): string {
    return purposeSecret(kind);
  }

  /**
   * Mint a password-reset token for an email. Non-enumerating: returns
   * `{ found:false }` for unknown/inactive accounts so the gateway can always
   * answer the client generically (BR-AUTH, no account disclosure).
   */
  async requestPasswordReset(
    email: string,
  ): Promise<{ found: boolean; resetToken: string; email: string; name: string }> {
    const emailNorm = (email ?? '').trim().toLowerCase();
    const empty = { found: false, resetToken: '', email: '', name: '' };
    if (!emailNorm || !emailNorm.includes('@')) return empty;
    const user = await this.prisma.user.findFirst({
      where: { email: emailNorm, isActive: true },
      select: { id: true, email: true, name: true },
    });
    if (!user) return empty;
    const resetToken = this.jwtService.sign(
      { sub: user.id, kind: 'pwd_reset' },
      { secret: this.purposeSecret('pwd_reset'), expiresIn: PWD_RESET_TTL },
    );
    return { found: true, resetToken, email: user.email, name: user.name ?? '' };
  }

  /** Consume a reset token: set the new password and revoke all sessions. */
  async resetPassword(token: string, newPassword: string): Promise<void> {
    let claims: { sub?: string; kind?: string; iat?: number };
    try {
      claims = this.jwtService.verify(token, { secret: this.purposeSecret('pwd_reset') });
    } catch {
      throw new RpcException({ code: status.FAILED_PRECONDITION, message: 'TOKEN_EXPIRED' });
    }
    if (claims.kind !== 'pwd_reset' || !claims.sub) {
      throw new RpcException({ code: status.INVALID_ARGUMENT, message: 'invalid token' });
    }
    if (!newPassword || newPassword.length < MIN_PASSWORD) {
      throw new RpcException({ code: status.INVALID_ARGUMENT, message: 'WEAK_PASSWORD' });
    }
    const user = await this.prisma.user.findFirst({
      where: { id: claims.sub, isActive: true },
      select: { id: true, passwordChangedAt: true },
    });
    if (!user)
      throw new RpcException({ code: status.FAILED_PRECONDITION, message: 'TOKEN_EXPIRED' });
    if (user.passwordChangedAt && claims.iat) {
      const issuedAt = claims.iat * 1000;
      if (issuedAt < user.passwordChangedAt.getTime()) {
        throw new RpcException({ code: status.FAILED_PRECONDITION, message: 'TOKEN_USED' });
      }
    }
    const passwordHash = await bcrypt.hash(newPassword, 10);
    const now = new Date();
    await this.prisma.user.update({
      where: { id: user.id },
      data: { passwordHash, passwordChangedAt: now },
    });
    // Invalidate every existing session — a reset implies the old password is compromised.
    await this.prisma.session.updateMany({
      where: { userId: user.id, revokedAt: null },
      data: { revokedAt: now, revokedReason: 'password_changed' },
    });
  }

  /**
   * Mint an email-verification token. Resolves the account by id (signup flow) or
   * email (resend flow). Non-enumerating and idempotent: `already_verified` short-
   * circuits without minting a token.
   */
  async requestEmailVerification(input: { userId?: string; email?: string }): Promise<{
    found: boolean;
    alreadyVerified: boolean;
    verifyToken: string;
    email: string;
    name: string;
  }> {
    const empty = { found: false, alreadyVerified: false, verifyToken: '', email: '', name: '' };
    const emailNorm = (input.email ?? '').trim().toLowerCase();
    const where = input.userId
      ? { id: input.userId, isActive: true }
      : emailNorm
        ? { email: emailNorm, isActive: true }
        : null;
    if (!where) return empty;
    const user = await this.prisma.user.findFirst({
      where,
      select: { id: true, email: true, name: true, emailVerified: true },
    });
    if (!user) return empty;
    if (user.emailVerified) {
      return {
        found: true,
        alreadyVerified: true,
        verifyToken: '',
        email: user.email,
        name: user.name ?? '',
      };
    }
    const verifyToken = this.jwtService.sign(
      { sub: user.id, kind: 'email_verify', em: user.email },
      { secret: this.purposeSecret('email_verify'), expiresIn: EMAIL_VERIFY_TTL },
    );
    return {
      found: true,
      alreadyVerified: false,
      verifyToken,
      email: user.email,
      name: user.name ?? '',
    };
  }

  /** Consume an email-verification token: mark the account verified (idempotent). */
  async confirmEmailVerification(token: string): Promise<string> {
    let claims: { sub?: string; kind?: string; em?: string };
    try {
      claims = this.jwtService.verify(token, { secret: this.purposeSecret('email_verify') });
    } catch {
      throw new RpcException({ code: status.FAILED_PRECONDITION, message: 'TOKEN_EXPIRED' });
    }
    if (claims.kind !== 'email_verify' || !claims.sub) {
      throw new RpcException({ code: status.INVALID_ARGUMENT, message: 'invalid token' });
    }
    const user = await this.prisma.user.findFirst({
      where: { id: claims.sub, isActive: true },
      select: { id: true, email: true, emailVerified: true },
    });
    if (!user)
      throw new RpcException({ code: status.FAILED_PRECONDITION, message: 'TOKEN_EXPIRED' });
    const tokenEmail = (claims.em ?? '').trim().toLowerCase();
    if (tokenEmail && tokenEmail !== user.email.toLowerCase()) {
      throw new RpcException({ code: status.FAILED_PRECONDITION, message: 'TOKEN_EXPIRED' });
    }
    if (!user.emailVerified) {
      await this.prisma.user.update({ where: { id: user.id }, data: { emailVerified: true } });
    }
    return user.id;
  }

  /** All non-secret user columns (the shape mapUser expects). */
  private static readonly PROFILE_SELECT = {
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
  } as const;

  /**
   * Idempotently provision a user by email — used by the org invitation accept
   * flow (control → auth, cross-domain). If a user with that email already
   * exists it is returned as-is (the password is NOT changed — an invite link
   * must never reset an existing account). Otherwise a new active user is
   * created with the given password; `login` defaults to the email (unique).
   */
  async provisionUser(
    email: string,
    name: string | undefined,
    password: string,
  ): Promise<{ user: AuthUserProfile; created: boolean }> {
    const emailNorm = email.trim().toLowerCase();
    if (!emailNorm) throw new AppError('auth', 'email required');

    const existing = await this.prisma.user.findFirst({
      where: { email: emailNorm },
      select: AuthService.PROFILE_SELECT,
    });
    if (existing) return { user: this.mapUser(existing), created: false };

    if (!password || password.length < MIN_PASSWORD) {
      throw new AppError('auth', 'password must be at least 8 characters');
    }
    const passwordHash = await bcrypt.hash(password, 10);
    // Prefer the email as login; fall back to a suffixed variant on the
    // (unlikely) chance the local part is already taken as someone's login.
    for (let attempt = 0; attempt < 3; attempt++) {
      let login = emailNorm;
      if (
        attempt > 0 ||
        (await this.prisma.user.findFirst({ where: { login }, select: { id: true } }))
      ) {
        login = `${emailNorm}-${newEntityId().slice(0, 6)}`;
      }
      try {
        const user = await this.prisma.user.create({
          data: {
            id: newEntityId(),
            login,
            email: emailNorm,
            passwordHash,
            name: name?.trim() || emailNorm,
            emailVerified: true,
          },
          select: AuthService.PROFILE_SELECT,
        });
        return { user: this.mapUser(user), created: true };
      } catch (e) {
        if (!isUniqueViolation(e)) throw e;
        // email raced to existence → return the now-existing account (idempotent, never resets password).
        if (uniqueTarget(e).includes('email')) {
          const existing = await this.prisma.user.findFirst({
            where: { email: emailNorm },
            select: AuthService.PROFILE_SELECT,
          });
          if (existing) return { user: this.mapUser(existing), created: false };
        }
        // login raced → loop retries with a fresh suffix.
      }
    }
    throw new AppError('auth', 'could not provision user (login collision)');
  }

  /** Read-only lookup by email (invitation pre-check: does the invitee exist?). */
  async getUserByEmail(email: string): Promise<AuthUserProfile | null> {
    const emailNorm = email.trim().toLowerCase();
    if (!emailNorm) return null;
    const user = await this.prisma.user.findFirst({
      where: { email: emailNorm },
      select: AuthService.PROFILE_SELECT,
    });
    return user ? this.mapUser(user) : null;
  }

  async me(userId: string): Promise<AuthUserProfile | null> {
    const id = userId?.trim();
    if (!id) return null;
    const user = await this.prisma.user.findFirst({
      where: { id, isActive: true },
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
    return user ? this.mapUser(user) : null;
  }

  /** Resolve a batch of user ids → minimal directory entries (id/name/email/login/avatarUrl).
   *  Used by other services (control's ListMembers, gateway employee enrichment).
   *  Missing/unknown ids are omitted. Batch size is capped (anti-scrape, contract §ResolveUsers). */
  async resolveUsers(ids: string[]): Promise<
    Array<{
      id: string;
      name: string;
      email: string;
      login: string;
      avatarUrl: string;
      position: string;
    }>
  > {
    const clean = [...new Set((ids ?? []).map((s) => s?.trim()).filter(Boolean))].slice(
      0,
      RESOLVE_USERS_MAX_BATCH,
    ) as string[];
    if (clean.length === 0) return [];
    const users = await this.prisma.user.findMany({
      where: { id: { in: clean } },
      select: { id: true, login: true, email: true, name: true, avatarUrl: true, position: true },
    });
    return users.map((u) => ({
      id: u.id,
      login: u.login,
      email: u.email,
      name: u.name ?? '',
      avatarUrl: u.avatarUrl ?? '',
      position: u.position ?? '',
    }));
  }

  async updateMe(userId: string, payload: UpdateMePayload): Promise<AuthUserProfile | null> {
    const id = userId?.trim();
    if (!id) return null;

    const data = {
      ...(payload.name !== undefined ? { name: payload.name.trim() || null } : {}),
      ...(payload.avatarUrl !== undefined ? { avatarUrl: payload.avatarUrl.trim() || null } : {}),
      ...(payload.phone !== undefined ? { phone: payload.phone.trim() || null } : {}),
      ...(payload.position !== undefined ? { position: payload.position.trim() || null } : {}),
      ...(payload.language !== undefined ? { language: payload.language.trim() || 'ru' } : {}),
      ...(payload.timezone !== undefined
        ? { timezone: payload.timezone.trim() || 'Europe/Moscow' }
        : {}),
      ...(payload.dateFormat !== undefined
        ? { dateFormat: payload.dateFormat.trim() || 'DD.MM.YYYY' }
        : {}),
      ...(payload.timeFormat !== undefined
        ? { timeFormat: payload.timeFormat.trim() || '24h' }
        : {}),
      ...(payload.thousandsSeparator !== undefined
        ? { thousandsSeparator: payload.thousandsSeparator.trim() || 'space' }
        : {}),
      ...(payload.defaultDealsView !== undefined
        ? { defaultDealsView: payload.defaultDealsView.trim() || 'kanban' }
        : {}),
      ...(payload.defaultActivitiesView !== undefined
        ? { defaultActivitiesView: payload.defaultActivitiesView.trim() || 'list' }
        : {}),
    };

    const user = await this.prisma.user
      .update({
        where: { id },
        data,
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
      })
      .catch((e: unknown) => {
        if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2025') return null;
        throw e;
      });
    if (!user) return null;
    return this.mapUser(user);
  }

  async listUsers(params: {
    skip: number;
    take: number;
    login?: string;
    isActive?: boolean;
  }): Promise<{
    list: {
      id: string;
      login: string;
      email: string;
      name: string | null;
      isActive: boolean;
      createdAt: Date;
    }[];
    total: number;
  }> {
    const take = Math.min(Math.max(params.take, 1), 100);
    const skip = Math.max(params.skip, 0);
    const where = {
      ...(params.login?.trim() && {
        login: { contains: params.login.trim(), mode: 'insensitive' as const },
      }),
      ...(params.isActive !== undefined && { isActive: params.isActive }),
    };
    const [list, total] = await Promise.all([
      this.prisma.user.findMany({
        where,
        skip,
        take,
        select: {
          id: true,
          login: true,
          email: true,
          name: true,
          isActive: true,
          createdAt: true,
        },
        orderBy: { createdAt: 'desc' },
      }),
      this.prisma.user.count({ where }),
    ]);
    return { list, total };
  }
}
