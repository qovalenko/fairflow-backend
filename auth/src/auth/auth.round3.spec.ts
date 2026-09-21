import { AuthService } from './auth.service';
import type { PrismaService } from '../prisma/prisma.service';
import type { JwtService } from '@nestjs/jwt';
import { Require2faPolicyService } from './require2fa-policy.service';
import {
  LoginAttemptStore,
  assertRedisConfiguredForProduction,
} from './login-attempt-store.service';

function makeAuth() {
  const user = {
    findFirst: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
    count: jest.fn().mockResolvedValue(0),
  };
  const session = {
    create: jest.fn().mockResolvedValue({}),
    findFirst: jest.fn(),
    update: jest.fn(),
    updateMany: jest.fn(),
  };
  const prisma = {
    user,
    session,
    $transaction: jest.fn(async (fn: (tx: { user: typeof user }) => Promise<unknown>) =>
      fn({ user } as never),
    ),
  } as unknown as PrismaService;
  const jwt = {
    sign: jest.fn().mockReturnValue('jwt'),
    verify: jest.fn(),
  } as unknown as JwtService;
  const denyPush = { pushDenied: jest.fn(), pushDeniedMany: jest.fn() };
  const service = new AuthService(
    prisma,
    jwt,
    denyPush as never,
    new Require2faPolicyService(),
    new LoginAttemptStore(),
  );
  return { service, user, session, prisma, jwt, denyPush };
}

describe('AuthService.register (FR-AUTH-022)', () => {
  it('rejects when any user already exists (serializable bootstrap barrier)', async () => {
    const { service, user } = makeAuth();
    user.count.mockResolvedValue(1);
    await expect(service.register('a', 'a@x.com', 'password1')).rejects.toMatchObject({
      errorCode: 'auth',
    });
    expect(user.create).not.toHaveBeenCalled();
  });
});

describe('AuthService.resetPassword (FR-AUTH-201)', () => {
  it('returns TOKEN_USED when token predates passwordChangedAt', async () => {
    const { service, jwt, user } = makeAuth();
    (jwt.verify as jest.Mock).mockReturnValue({
      sub: 'u1',
      kind: 'pwd_reset',
      iat: 100,
    });
    user.findFirst.mockResolvedValue({
      id: 'u1',
      passwordChangedAt: new Date(200_000),
    });
    await expect(service.resetPassword('tok', 'password1')).rejects.toMatchObject({
      message: 'TOKEN_USED',
    });
  });
});

describe('AuthService.checkSession (FR-AUTH-170)', () => {
  it('returns password_changed reason from revokedReason column', async () => {
    const { service, session } = makeAuth();
    session.findFirst.mockResolvedValue({
      id: 's1',
      revokedAt: new Date(),
      revokedReason: 'password_changed',
      expiresAt: new Date(Date.now() + 60_000),
    });
    await expect(service.checkSession('u1', 'jti')).resolves.toEqual({
      valid: false,
      reason: 'password_changed',
    });
  });
});

describe('assertRedisConfiguredForProduction (FR-AUTH-060)', () => {
  const OLD = process.env.NODE_ENV;
  afterEach(() => {
    process.env.NODE_ENV = OLD;
    delete process.env.REDIS_URL;
  });

  it('throws outside development when REDIS_URL is missing', () => {
    process.env.NODE_ENV = 'production';
    expect(() => assertRedisConfiguredForProduction()).toThrow(/REDIS_URL/);
  });
});
