import * as bcrypt from 'bcryptjs';
import { AuthService } from './auth.service';
import type { PrismaService } from '../prisma/prisma.service';
import type { JwtService } from '@nestjs/jwt';
import { Require2faPolicyService } from './require2fa-policy.service';
import { LoginAttemptStore } from './login-attempt-store.service';
import { encryptSecret, generateBase32Secret, verifyTotp } from './totp.util';

function makeRequire2faPolicy(required = false): Require2faPolicyService {
  const svc = new Require2faPolicyService();
  svc.setRequired(required);
  return svc;
}

/**
 * Additional AuthService component tests (QA-CI T-036.1) covering the success
 * branches not exercised by auth.service.spec: profile read/update, registration,
 * OAuth provisioning, second-factor via a backup code, and email-verification
 * confirmation. Prisma/JWT mocked at the boundary.
 */
function makeService() {
  const user = {
    findFirst: jest.fn(),
    findMany: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
    count: jest.fn().mockResolvedValue(0),
  };
  const session = { create: jest.fn().mockResolvedValue({}), updateMany: jest.fn() };
  const userBackupCode = {
    findMany: jest.fn(),
    update: jest.fn().mockResolvedValue({}),
    count: jest.fn(),
  };
  const prisma = {
    user,
    session,
    userBackupCode,
    $transaction: jest.fn(async (fn: (tx: { user: typeof user }) => Promise<unknown>) =>
      fn({ user } as never),
    ),
  } as unknown as PrismaService;
  const jwt = {
    sign: jest.fn().mockReturnValue('jwt'),
    verify: jest.fn(),
  } as unknown as JwtService;
  const denyPush = {
    pushDenied: jest.fn().mockResolvedValue(undefined),
    pushDeniedMany: jest.fn().mockResolvedValue(undefined),
  };
  return {
    service: new AuthService(
      prisma,
      jwt,
      denyPush as never,
      makeRequire2faPolicy(),
      new LoginAttemptStore(),
    ),
    user,
    session,
    userBackupCode,
    jwt,
    denyPush,
  };
}

const row = (over: Record<string, unknown> = {}) => ({
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

describe('AuthService.me / updateMe', () => {
  it('me returns null for a blank id and for an unknown user', async () => {
    const { service, user } = makeService();
    expect(await service.me('  ')).toBeNull();
    user.findFirst.mockResolvedValue(null);
    expect(await service.me('u1')).toBeNull();
  });

  it('me maps an active user', async () => {
    const { service, user } = makeService();
    user.findFirst.mockResolvedValue(row());
    expect(await service.me('u1')).toMatchObject({ id: 'u1', email: 'alice@example.com' });
  });

  it('updateMe trims/normalises fields and maps the updated row', async () => {
    const { service, user } = makeService();
    user.update.mockResolvedValue(row({ name: 'Bob' }));
    const res = await service.updateMe('u1', { name: '  Bob  ', language: '' });
    expect(res).toMatchObject({ name: 'Bob' });
    const data = user.update.mock.calls[0][0].data;
    expect(data.name).toBe('Bob');
    expect(data.language).toBe('ru'); // empty → default
  });

  it('updateMe returns null for a blank id (no write)', async () => {
    const { service, user } = makeService();
    expect(await service.updateMe('', {})).toBeNull();
    expect(user.update).not.toHaveBeenCalled();
  });
});

describe('AuthService.register', () => {
  it('rejects a duplicate (existing login/email) with an "exists" error', async () => {
    const { service, user } = makeService();
    user.findFirst.mockResolvedValue({ id: 'dup' });
    await expect(service.register('alice', 'alice@example.com', 'password1')).rejects.toMatchObject(
      {
        message: expect.stringContaining('exists'),
      },
    );
    expect(user.create).not.toHaveBeenCalled();
  });

  it('rejects missing login/email', async () => {
    const { service } = makeService();
    await expect(service.register('', 'a@x', 'pw')).rejects.toMatchObject({ errorCode: 'auth' });
  });

  it('creates a user and issues a token on success', async () => {
    const { service, user } = makeService();
    user.findFirst.mockResolvedValue(null);
    user.create.mockResolvedValue(row());
    const res = await service.register('alice', 'Alice@Example.com', 'password1');
    expect(res.accessToken).toBe('jwt');
    // email normalised to lower-case on create
    expect(user.create.mock.calls[0][0].data.email).toBe('alice@example.com');
    expect(user.create.mock.calls[0][0].data.emailVerified).toBe(true);
  });
});

describe('AuthService.oauthLogin', () => {
  it('rejects when the provider returns no usable email', async () => {
    const { service } = makeService();
    await expect(
      service.oauthLogin({ provider: 'y', externalId: 'e', email: '' }),
    ).rejects.toMatchObject({ errorCode: 'auth' });
  });

  it('adopts an existing account by email and starts a session', async () => {
    const { service, user } = makeService();
    user.findFirst
      .mockResolvedValueOnce({ id: 'u1', avatarUrl: 'http://a' }) // find by email
      .mockResolvedValueOnce({ id: 'u1', twoFactorEnabled: false }) // startSessionOrChallenge
      .mockResolvedValueOnce(row()); // me()
    const res = await service.oauthLogin({
      provider: 'y',
      externalId: 'e',
      email: 'alice@example.com',
    });
    expect(res.mfaRequired).toBe(false);
    expect(user.create).not.toHaveBeenCalled();
  });

  it('provisions a new external-only account when the email is unknown', async () => {
    const { service, user } = makeService();
    user.findFirst.mockResolvedValueOnce(null);
    await expect(
      service.oauthLogin({
        provider: 'y',
        externalId: 'e',
        email: 'new@example.com',
        name: 'New',
      }),
    ).rejects.toMatchObject({ errorCode: 'auth' });
    expect(user.create).not.toHaveBeenCalled();
  });
});

describe('AuthService.verifyMfa — success via a one-time backup code', () => {
  it('redeems a valid backup code, marks it used, and issues a token', async () => {
    const { service, jwt, user, userBackupCode } = makeService();
    const secret = generateBase32Secret();
    (jwt.verify as jest.Mock).mockReturnValue({ sub: 'u1', kind: 'mfa_challenge', jti: 'ch-b1' });
    user.findFirst
      .mockResolvedValueOnce({
        id: 'u1',
        twoFactorEnabled: true,
        twoFactorSecret: encryptSecret(secret),
      })
      .mockResolvedValueOnce(row()); // me()
    const code = 'abcd-1234';
    userBackupCode.findMany.mockResolvedValue([{ id: 'bc1', codeHash: bcrypt.hashSync(code, 4) }]);
    // ensure the code is NOT a currently-valid TOTP (so the backup path is taken)
    expect(verifyTotp(secret, code)).toBe(false);
    const res = await service.verifyMfa('preauth', code);
    expect(res.accessToken).toBe('jwt');
    expect(userBackupCode.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'bc1' } }),
    );
  });

  it('rejects a wrong second factor (neither TOTP nor a backup code) with INVALID_TOTP', async () => {
    const { service, jwt, user, userBackupCode } = makeService();
    (jwt.verify as jest.Mock).mockReturnValue({ sub: 'u1', kind: 'mfa_challenge', jti: 'ch-b2' });
    user.findFirst.mockResolvedValue({
      id: 'u1',
      twoFactorEnabled: true,
      twoFactorSecret: encryptSecret(generateBase32Secret()),
    });
    userBackupCode.findMany.mockResolvedValue([]);
    await expect(service.verifyMfa('preauth', 'zzzz-9999')).rejects.toMatchObject({
      message: 'INVALID_TOTP',
    });
  });
});

describe('AuthService.confirmEmailVerification / me2faStatus / getUserByEmail', () => {
  it('confirmEmailVerification marks an unverified account verified (idempotent)', async () => {
    const { service, jwt, user } = makeService();
    (jwt.verify as jest.Mock).mockReturnValue({ sub: 'u1', kind: 'email_verify', em: 'a@b.c' });
    user.findFirst.mockResolvedValue({ id: 'u1', email: 'a@b.c', emailVerified: false });
    const uid = await service.confirmEmailVerification('tok');
    expect(uid).toBe('u1');
    expect(user.update).toHaveBeenCalled();
  });

  it('confirmEmailVerification rejects a token when the email no longer matches', async () => {
    const { service, jwt, user } = makeService();
    (jwt.verify as jest.Mock).mockReturnValue({
      sub: 'u1',
      kind: 'email_verify',
      em: 'old@b.c',
    });
    user.findFirst.mockResolvedValue({ id: 'u1', email: 'new@b.c', emailVerified: false });
    await expect(service.confirmEmailVerification('tok')).rejects.toMatchObject({
      message: 'TOKEN_EXPIRED',
    });
    expect(user.update).not.toHaveBeenCalled();
  });

  it('confirmEmailVerification rejects a token of the wrong kind', async () => {
    const { service, jwt } = makeService();
    (jwt.verify as jest.Mock).mockReturnValue({ sub: 'u1', kind: 'pwd_reset' });
    await expect(service.confirmEmailVerification('tok')).rejects.toMatchObject({
      error: { message: 'invalid token' },
    });
  });

  it('me2faStatus reports enabled + remaining backup codes', async () => {
    const { service, user, userBackupCode } = makeService();
    user.findFirst.mockResolvedValue({ id: 'u1', twoFactorEnabled: true });
    userBackupCode.count.mockResolvedValue(7);
    expect(await service.me2faStatus('u1')).toEqual({
      twoFactorEnabled: true,
      require2fa: false,
      backupCodesRemaining: 7,
    });
  });

  it('me2faStatus reflects org require2fa policy flag', async () => {
    const user = {
      findFirst: jest.fn(),
      findMany: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      count: jest.fn(),
    };
    const session = { create: jest.fn().mockResolvedValue({}), updateMany: jest.fn() };
    const userBackupCode = {
      findMany: jest.fn(),
      update: jest.fn().mockResolvedValue({}),
      count: jest.fn().mockResolvedValue(0),
    };
    const prisma = { user, session, userBackupCode } as unknown as PrismaService;
    const jwt = {
      sign: jest.fn().mockReturnValue('jwt'),
      verify: jest.fn(),
    } as unknown as JwtService;
    const denyPush = {
      pushDenied: jest.fn().mockResolvedValue(undefined),
      pushDeniedMany: jest.fn().mockResolvedValue(undefined),
    };
    const service = new AuthService(
      prisma,
      jwt,
      denyPush as never,
      makeRequire2faPolicy(true),
      new LoginAttemptStore(),
    );
    user.findFirst.mockResolvedValue({ id: 'u1', twoFactorEnabled: false });
    expect(await service.me2faStatus('u1')).toEqual({
      twoFactorEnabled: false,
      require2fa: true,
      backupCodesRemaining: 0,
    });
  });

  it('me2faStatus is all-false for a blank id', async () => {
    const { service } = makeService();
    expect(await service.me2faStatus('  ')).toEqual({
      twoFactorEnabled: false,
      require2fa: false,
      backupCodesRemaining: 0,
    });
  });

  it('getUserByEmail returns null for a blank/unknown email and maps a hit', async () => {
    const { service, user } = makeService();
    expect(await service.getUserByEmail('  ')).toBeNull();
    user.findFirst.mockResolvedValue(row());
    expect(await service.getUserByEmail('Alice@Example.com')).toMatchObject({ id: 'u1' });
  });
});
