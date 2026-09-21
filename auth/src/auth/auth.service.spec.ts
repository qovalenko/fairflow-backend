import * as bcrypt from 'bcryptjs';
import { AuthService } from './auth.service';
import { AppError } from '../common/errors';
import type { PrismaService } from '../prisma/prisma.service';
import type { JwtService } from '@nestjs/jwt';
import { Require2faPolicyService } from './require2fa-policy.service';
import { LoginAttemptStore } from './login-attempt-store.service';
import { encryptSecret, generateBase32Secret, generateTotp } from './totp.util';

function makeRequire2faPolicy(required = false): Require2faPolicyService {
  const svc = new Require2faPolicyService();
  svc.setRequired(required);
  return svc;
}

/**
 * Component tests for AuthService (QA-CI T-036.1, P0 auth). Prisma + JWT are
 * mocked at the boundary (QA-STRATEGY §7 component level); the real credential,
 * brute-force, session-deny-list, token-issuance and non-enumeration logic runs.
 * The JTI deny-list (isSessionValid) is the auth half of the gateway PEP — its
 * fail-closed-on-revoke / fail-open-on-untracked contract is security-critical.
 */
function makeService() {
  const user = {
    findFirst: jest.fn(),
    findMany: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
    count: jest.fn(),
  };
  const session = {
    create: jest.fn().mockResolvedValue({}),
    findFirst: jest.fn(),
    updateMany: jest.fn().mockResolvedValue({ count: 0 }),
    update: jest.fn().mockResolvedValue({}),
    findMany: jest.fn(),
  };
  const userBackupCode = {
    findMany: jest.fn(),
    update: jest.fn(),
    deleteMany: jest.fn(),
    create: jest.fn(),
    count: jest.fn(),
  };
  const prisma = { user, session, userBackupCode } as unknown as PrismaService;
  const jwt = {
    sign: jest.fn().mockReturnValue('signed.jwt.token'),
    verify: jest.fn(),
  } as unknown as JwtService;
  const denyPush = {
    pushDenied: jest.fn().mockResolvedValue(undefined),
    pushDeniedMany: jest.fn().mockResolvedValue(undefined),
  };
  const loginAttempts = new LoginAttemptStore();
  const service = new AuthService(
    prisma,
    jwt,
    denyPush as never,
    makeRequire2faPolicy(),
    loginAttempts,
  );
  return { service, user, session, userBackupCode, jwt, denyPush, loginAttempts };
}

const activeUserRow = (over: Record<string, unknown> = {}) => ({
  id: 'u1',
  login: 'alice',
  email: 'alice@example.com',
  name: 'Alice',
  avatarUrl: null,
  phone: null,
  position: null,
  language: 'ru',
  timezone: 'Europe/Moscow',
  dateFormat: 'DD.MM.YYYY',
  timeFormat: '24h',
  thousandsSeparator: 'space',
  defaultDealsView: 'kanban',
  defaultActivitiesView: 'list',
  ...over,
});

describe('AuthService.validateUser', () => {
  it('returns the mapped profile for correct credentials (bcrypt verified)', async () => {
    const { service, user } = makeService();
    const passwordHash = bcrypt.hashSync('s3cret', 4);
    user.findFirst.mockResolvedValue(activeUserRow({ passwordHash }));
    const res = await service.validateUser('alice', 's3cret');
    expect(res).toMatchObject({ id: 'u1', login: 'alice', email: 'alice@example.com' });
    // lookup is scoped to active users and matches login OR (case-insensitive) email
    expect(user.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ isActive: true, emailVerified: true }),
      }),
    );
  });

  it('does not authenticate unverified accounts (FR-AUTH-050)', async () => {
    const { service, user } = makeService();
    user.findFirst.mockResolvedValue(null);
    expect(await service.validateUser('alice', 's3cret')).toBeNull();
  });

  it('returns null on wrong password and on empty identifier (no query)', async () => {
    const { service, user } = makeService();
    user.findFirst.mockResolvedValue(activeUserRow({ passwordHash: bcrypt.hashSync('right', 4) }));
    expect(await service.validateUser('alice', 'wrong')).toBeNull();
    expect(await service.validateUser('   ', 'x')).toBeNull();
    // empty identifier short-circuits before hitting the DB
    expect(user.findFirst).toHaveBeenCalledTimes(1);
  });
});

describe('AuthService brute-force throttle (#11)', () => {
  it('locks the key after 5 consecutive failures → rateLimit AppError', async () => {
    const { service, user } = makeService();
    user.findFirst.mockResolvedValue(null); // always invalid creds
    for (let i = 0; i < 5; i++) {
      await expect(service.loginWithMfa('bob', 'nope')).rejects.toMatchObject({
        errorCode: 'auth',
      });
    }
    // 6th attempt is refused before even checking credentials
    await expect(service.loginWithMfa('bob', 'nope')).rejects.toMatchObject({
      errorCode: 'rateLimit',
    });
  });

  it('a successful login clears the failure counter', async () => {
    const { service, user } = makeService();
    const passwordHash = bcrypt.hashSync('pw', 4);
    // 4 fails then success
    user.findFirst.mockResolvedValue(null);
    for (let i = 0; i < 4; i++) {
      await expect(service.validateAndLogin('bob', 'nope')).rejects.toBeInstanceOf(AppError);
    }
    user.findFirst.mockResolvedValue(activeUserRow({ id: 'bob', passwordHash }));
    await expect(service.validateAndLogin('bob', 'pw')).resolves.toMatchObject({
      accessToken: 'signed.jwt.token',
    });
    // counter reset → a fresh failure run must again take 5 to lock
    user.findFirst.mockResolvedValue(null);
    await expect(service.loginWithMfa('bob', 'nope')).rejects.toMatchObject({ errorCode: 'auth' });
  });

  it('an identifier crafted as "ip:<addr>" cannot lock out that IP (disjoint key namespaces)', async () => {
    const { service, user } = makeService();
    const passwordHash = bcrypt.hashSync('pw', 4);
    user.findFirst.mockResolvedValue(null);
    for (let i = 0; i < 5; i++) {
      await expect(service.loginWithMfa('ip:9.9.9.9', 'nope')).rejects.toMatchObject({
        errorCode: 'auth',
      });
    }
    // the crafted identifier itself is locked…
    await expect(service.loginWithMfa('ip:9.9.9.9', 'nope')).rejects.toMatchObject({
      errorCode: 'rateLimit',
    });
    // …but a legitimate login coming FROM that IP is unaffected
    user.findFirst
      .mockResolvedValueOnce(activeUserRow({ passwordHash }))
      .mockResolvedValueOnce({ id: 'u1', twoFactorEnabled: false })
      .mockResolvedValueOnce(activeUserRow());
    const res = await service.loginWithMfa('alice', 'pw', { ip: '9.9.9.9' });
    expect(res.mfaRequired).toBe(false);
  });

  it('the shared-IP key locks at a laxer budget than the identifier key', async () => {
    const { service, user } = makeService();
    const passwordHash = bcrypt.hashSync('pw', 4);
    user.findFirst.mockResolvedValue(null);
    // 5 failures across DIFFERENT identifiers from one IP must not lock that IP
    // (NAT/ingress funnel many users through one address)…
    for (let i = 0; i < 5; i++) {
      await expect(
        service.loginWithMfa(`user${i}`, 'nope', { ip: '10.0.0.7' }),
      ).rejects.toMatchObject({ errorCode: 'auth' });
    }
    user.findFirst
      .mockResolvedValueOnce(activeUserRow({ passwordHash }))
      .mockResolvedValueOnce({ id: 'u1', twoFactorEnabled: false })
      .mockResolvedValueOnce(activeUserRow());
    await expect(service.loginWithMfa('alice', 'pw', { ip: '10.0.0.7' })).resolves.toMatchObject({
      mfaRequired: false,
    });
    // …but a cross-identifier spray from one host still trips the IP lock.
    user.findFirst.mockResolvedValue(null);
    for (let i = 0; i < 30; i++) {
      await expect(
        service.loginWithMfa(`spray${i}`, 'nope', { ip: '10.0.0.8' }),
      ).rejects.toMatchObject({ errorCode: 'auth' });
    }
    await expect(service.loginWithMfa('victim', 'pw', { ip: '10.0.0.8' })).rejects.toMatchObject({
      errorCode: 'rateLimit',
    });
  });
});

describe('AuthService.loginWithMfa / startSessionOrChallenge', () => {
  it('issues a token directly when 2FA is off', async () => {
    const { service, user } = makeService();
    const passwordHash = bcrypt.hashSync('pw', 4);
    user.findFirst
      .mockResolvedValueOnce(activeUserRow({ passwordHash })) // validateUser
      .mockResolvedValueOnce({ id: 'u1', twoFactorEnabled: false }) // startSessionOrChallenge flags
      .mockResolvedValueOnce(activeUserRow()); // me()
    const res = await service.loginWithMfa('alice', 'pw');
    expect(res.mfaRequired).toBe(false);
    expect(res.auth?.accessToken).toBe('signed.jwt.token');
  });

  it('returns a preauth challenge (no JWT) when 2FA is on', async () => {
    const { service, user, jwt } = makeService();
    const passwordHash = bcrypt.hashSync('pw', 4);
    user.findFirst
      .mockResolvedValueOnce(activeUserRow({ passwordHash }))
      .mockResolvedValueOnce({ id: 'u1', twoFactorEnabled: true });
    (jwt.sign as jest.Mock).mockReturnValue('preauth.challenge');
    const res = await service.loginWithMfa('alice', 'pw');
    expect(res).toEqual({ mfaRequired: true, preauthId: 'preauth.challenge' });
    // TODO-006: the challenge is purpose-scoped — a derived secret (never the
    // access-token key) and a jti for one-shot redemption.
    const [payload, opts] = (jwt.sign as jest.Mock).mock.calls[0];
    expect(payload).toMatchObject({ kind: 'mfa_challenge', jti: expect.any(String) });
    expect(opts.secret).toEqual(expect.stringContaining(':mfa_challenge'));
  });
});

describe('AuthService.verifyMfa', () => {
  it('CHALLENGE_EXPIRED when the preauth token does not verify', async () => {
    const { service, jwt } = makeService();
    (jwt.verify as jest.Mock).mockImplementation(() => {
      throw new Error('expired');
    });
    await expect(service.verifyMfa('bad', '123456')).rejects.toMatchObject({
      message: 'CHALLENGE_EXPIRED',
    });
  });

  it('INVALID_CHALLENGE for a token of the wrong kind', async () => {
    const { service, jwt } = makeService();
    (jwt.verify as jest.Mock).mockReturnValue({ sub: 'u1', kind: 'not_mfa' });
    await expect(service.verifyMfa('t', '123456')).rejects.toMatchObject({
      message: 'INVALID_CHALLENGE',
    });
  });

  it('INVALID_CHALLENGE when the user has no 2FA secret', async () => {
    const { service, jwt, user } = makeService();
    (jwt.verify as jest.Mock).mockReturnValue({ sub: 'u1', kind: 'mfa_challenge', jti: 'ch1' });
    user.findFirst.mockResolvedValue({ id: 'u1', twoFactorEnabled: false, twoFactorSecret: null });
    await expect(service.verifyMfa('t', '123456')).rejects.toMatchObject({
      message: 'INVALID_CHALLENGE',
    });
  });

  it('verifies the challenge with the purpose-scoped secret, not the access-token key', async () => {
    const { service, jwt } = makeService();
    (jwt.verify as jest.Mock).mockImplementation(() => {
      throw new Error('bad signature');
    });
    await expect(service.verifyMfa('t', '123456')).rejects.toMatchObject({
      message: 'CHALLENGE_EXPIRED',
    });
    const [, opts] = (jwt.verify as jest.Mock).mock.calls[0];
    expect(opts.secret).toEqual(expect.stringContaining(':mfa_challenge'));
  });

  it('INVALID_CHALLENGE for a challenge without a jti (pre-fix token shape)', async () => {
    const { service, jwt, user } = makeService();
    (jwt.verify as jest.Mock).mockReturnValue({ sub: 'u1', kind: 'mfa_challenge' });
    await expect(service.verifyMfa('t', '123456')).rejects.toMatchObject({
      message: 'INVALID_CHALLENGE',
    });
    expect(user.findFirst).not.toHaveBeenCalled();
  });

  it('a redeemed challenge cannot be replayed (one-shot jti)', async () => {
    const { service, jwt, user } = makeService();
    const secret = generateBase32Secret();
    (jwt.verify as jest.Mock).mockReturnValue({
      sub: 'u1',
      kind: 'mfa_challenge',
      jti: 'ch-once',
      exp: Math.floor(Date.now() / 1000) + 300,
    });
    user.findFirst
      .mockResolvedValueOnce({
        id: 'u1',
        twoFactorEnabled: true,
        twoFactorSecret: encryptSecret(secret),
      })
      .mockResolvedValueOnce(activeUserRow()); // me()
    const res = await service.verifyMfa('t', generateTotp(secret));
    expect(res.accessToken).toBe('signed.jwt.token');
    // Second redemption of the same challenge (even with a fresh valid code) → rejected.
    await expect(service.verifyMfa('t', generateTotp(secret))).rejects.toMatchObject({
      message: 'CHALLENGE_EXPIRED',
    });
  });

  it('burns the challenge after 5 wrong codes (per-challenge budget, TODO-061)', async () => {
    const { service, jwt, user } = makeService();
    const secret = generateBase32Secret();
    (jwt.verify as jest.Mock).mockReturnValue({
      sub: 'u1',
      kind: 'mfa_challenge',
      jti: 'ch-budget',
      exp: Math.floor(Date.now() / 1000) + 300,
    });
    user.findFirst.mockResolvedValue({
      id: 'u1',
      twoFactorEnabled: true,
      twoFactorSecret: encryptSecret(secret),
    });
    const valid = generateTotp(secret);
    const wrong = valid === '000000' ? '111111' : '000000';
    for (let i = 0; i < 5; i++) {
      await expect(service.verifyMfa('t', wrong)).rejects.toMatchObject({
        message: 'INVALID_TOTP',
      });
    }
    // budget exhausted — even the correct code can no longer redeem this challenge
    await expect(service.verifyMfa('t', valid)).rejects.toMatchObject({
      message: 'CHALLENGE_EXPIRED',
    });
  });
});

describe('AuthService.isSessionValid (JTI deny-list, BR-AUTH-09)', () => {
  it('false for missing user/session id (no query)', async () => {
    const { service, session } = makeService();
    expect(await service.isSessionValid('', 's')).toBe(false);
    expect(await service.isSessionValid('u', '')).toBe(false);
    expect(session.findFirst).not.toHaveBeenCalled();
  });

  it('true for an UNTRACKED token (row absent) — fail-open on infra, not security', async () => {
    const { service, session } = makeService();
    session.findFirst.mockResolvedValue(null);
    expect(await service.isSessionValid('u1', 'jti-legacy')).toBe(true);
  });

  it('false for an explicitly REVOKED session (authoritative negative)', async () => {
    const { service, session } = makeService();
    session.findFirst.mockResolvedValue({ id: 's1', revokedAt: new Date(), expiresAt: null });
    expect(await service.isSessionValid('u1', 'jti')).toBe(false);
  });

  it('false for an EXPIRED session', async () => {
    const { service, session } = makeService();
    session.findFirst.mockResolvedValue({
      id: 's1',
      revokedAt: null,
      expiresAt: new Date(Date.now() - 1000),
    });
    expect(await service.isSessionValid('u1', 'jti')).toBe(false);
  });

  it('true for a live session and bumps lastSeenAt opportunistically', async () => {
    const { service, session } = makeService();
    session.findFirst.mockResolvedValue({
      id: 's1',
      revokedAt: null,
      expiresAt: new Date(Date.now() + 60_000),
    });
    expect(await service.isSessionValid('u1', 'jti')).toBe(true);
    expect(session.update).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 's1' } }));
  });
});

describe('AuthService.logout', () => {
  it('marks the calling session (by jti) revoked; idempotent no-op on empty input', async () => {
    const { service, session } = makeService();
    await service.logout('u1', 'jti-1');
    expect(session.updateMany).toHaveBeenCalledWith({
      where: { userId: 'u1', tokenId: 'jti-1', revokedAt: null },
      data: { revokedAt: expect.any(Date), revokedReason: 'signed_out' },
    });
    session.updateMany.mockClear();
    await service.logout('', 's');
    await service.logout('u', '');
    expect(session.updateMany).not.toHaveBeenCalled();
  });
});

describe('AuthService password-recovery (non-enumerating)', () => {
  it('requestPasswordReset returns found:false for unknown/invalid email (no token leak)', async () => {
    const { service, user, jwt } = makeService();
    user.findFirst.mockResolvedValue(null);
    expect(await service.requestPasswordReset('nobody@example.com')).toEqual({
      found: false,
      resetToken: '',
      email: '',
      name: '',
    });
    // malformed email short-circuits before the DB
    expect(await service.requestPasswordReset('not-an-email')).toMatchObject({ found: false });
    expect(jwt.sign).not.toHaveBeenCalled();
  });

  it('requestPasswordReset mints a purpose-scoped token for a known account', async () => {
    const { service, user, jwt } = makeService();
    user.findFirst.mockResolvedValue({ id: 'u1', email: 'alice@example.com', name: 'Alice' });
    const r = await service.requestPasswordReset('Alice@Example.com');
    expect(r.found).toBe(true);
    expect(r.resetToken).toBe('signed.jwt.token');
    // signed with a DIFFERENT (derived) secret than access tokens
    expect((jwt.sign as jest.Mock).mock.calls[0][1]).toMatchObject({
      secret: expect.stringContaining(':pwd_reset'),
    });
  });

  it('resetPassword rejects a weak new password with INVALID_ARGUMENT', async () => {
    const { service, jwt } = makeService();
    (jwt.verify as jest.Mock).mockReturnValue({ sub: 'u1', kind: 'pwd_reset' });
    await expect(service.resetPassword('tok', 'short')).rejects.toMatchObject({
      error: { message: 'WEAK_PASSWORD' },
    });
  });

  it('resetPassword rejects an expired/invalid token with TOKEN_EXPIRED', async () => {
    const { service, jwt } = makeService();
    (jwt.verify as jest.Mock).mockImplementation(() => {
      throw new Error('bad');
    });
    await expect(service.resetPassword('tok', 'longenough')).rejects.toMatchObject({
      error: { message: 'TOKEN_EXPIRED' },
    });
  });

  it('resetPassword rejects a token issued before passwordChangedAt with TOKEN_USED', async () => {
    const { service, user, jwt } = makeService();
    const changedAt = new Date('2026-01-02T00:00:00.000Z');
    (jwt.verify as jest.Mock).mockReturnValue({
      sub: 'u1',
      kind: 'pwd_reset',
      iat: Math.floor(new Date('2026-01-01T00:00:00.000Z').getTime() / 1000),
    });
    user.findFirst.mockResolvedValue({ id: 'u1', passwordChangedAt: changedAt });
    await expect(service.resetPassword('tok', 'longenough')).rejects.toMatchObject({
      error: { message: 'TOKEN_USED' },
    });
  });
});

describe('AuthService.provisionUser (idempotent invite accept)', () => {
  it('returns the existing account (created:false) and NEVER resets its password', async () => {
    const { service, user } = makeService();
    user.findFirst.mockResolvedValue(activeUserRow({ id: 'existing' }));
    const r = await service.provisionUser('alice@example.com', 'Alice', 'whatever');
    expect(r).toMatchObject({ created: false, user: { id: 'existing' } });
    expect(user.create).not.toHaveBeenCalled();
  });

  it('creates a fresh active user (created:true) when the email is new', async () => {
    const { service, user } = makeService();
    user.findFirst
      .mockResolvedValueOnce(null) // no existing by email
      .mockResolvedValueOnce(null); // login not taken
    user.create.mockResolvedValue(activeUserRow({ id: 'new-u' }));
    const r = await service.provisionUser('new@example.com', 'New', 'password1');
    expect(r).toMatchObject({ created: true, user: { id: 'new-u' } });
  });

  it('rejects an empty email and a too-short password', async () => {
    const { service, user } = makeService();
    await expect(service.provisionUser('  ', 'X', 'password1')).rejects.toMatchObject({
      errorCode: 'auth',
    });
    user.findFirst.mockResolvedValue(null);
    await expect(service.provisionUser('new@example.com', 'X', 'short')).rejects.toMatchObject({
      errorCode: 'auth',
    });
  });
});

describe('AuthService.resolveUsers / listUsers', () => {
  it('resolveUsers dedups, drops blanks and returns [] for an empty batch', async () => {
    const { service, user } = makeService();
    expect(await service.resolveUsers([])).toEqual([]);
    expect(await service.resolveUsers(['', '  '])).toEqual([]);
    expect(user.findMany).not.toHaveBeenCalled();

    user.findMany.mockResolvedValue([
      { id: 'u1', login: 'a', email: 'a@x', name: 'A', avatarUrl: null },
    ]);
    const r = await service.resolveUsers(['u1', 'u1', ' u2 ']);
    expect(user.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: { in: ['u1', 'u2'] } } }),
    );
    expect(r[0]).toEqual({
      id: 'u1',
      login: 'a',
      email: 'a@x',
      name: 'A',
      avatarUrl: '',
      position: '',
    });
  });

  it('listUsers clamps take to [1,100] and skip to >=0', async () => {
    const { service, user } = makeService();
    user.findMany.mockResolvedValue([]);
    user.count.mockResolvedValue(0);
    await service.listUsers({ skip: -5, take: 9999 });
    expect(user.findMany).toHaveBeenCalledWith(expect.objectContaining({ skip: 0, take: 100 }));
  });
});

describe('AuthService.requestEmailVerification', () => {
  it('short-circuits already_verified without minting a token', async () => {
    const { service, user, jwt } = makeService();
    user.findFirst.mockResolvedValue({
      id: 'u1',
      email: 'a@x',
      name: 'A',
      emailVerified: true,
    });
    const r = await service.requestEmailVerification({ userId: 'u1' });
    expect(r).toMatchObject({ found: true, alreadyVerified: true, verifyToken: '' });
    expect(jwt.sign).not.toHaveBeenCalled();
  });

  it('returns found:false when neither userId nor email is given', async () => {
    const { service } = makeService();
    expect(await service.requestEmailVerification({})).toMatchObject({ found: false });
  });
});
