import { execFileSync } from 'node:child_process';
import * as path from 'node:path';
import * as bcrypt from 'bcryptjs';
import { PrismaPg } from '@prisma/adapter-pg';
import { JwtService } from '@nestjs/jwt';
import { createEphemeralDatabase, describeIntegration, id } from '@fairflow/testing';
import { PrismaClient } from '../generated/prisma';
import { AuthService, type JwtPayload } from './auth.service';
import { SessionDenyPushService } from './session-deny-push.service';
import { Require2faPolicyService } from './require2fa-policy.service';
import { LoginAttemptStore } from './login-attempt-store.service';
import { AppError } from '../common/errors';

/**
 * Auth login integration (QA-CI T-036.2, wave auth-access-flow). Real Postgres +
 * bcrypt + JWT issuance — the auth half of login → JWT → gateway guard → PDP.
 *
 * Complements auth.session.integration.spec.ts (session/deny-list semantics) with
 * the credential path the gateway JWT guard ultimately trusts: validateUser,
 * loginWithMfa, token claims, and isSessionValid after logout.
 */
describeIntegration('auth login (real Postgres + bcrypt + JWT)', () => {
  const JWT_SECRET = 'integration-login-secret-min-32-chars-00';
  let prisma: PrismaClient;
  let auth: AuthService;
  let jwt: JwtService;
  let dropDb: () => Promise<void>;

  const PASSWORD = 'Str0ngPass!';

  async function seedVerifiedUser(login: string, password = PASSWORD): Promise<string> {
    const uid = id('user');
    const hash = await bcrypt.hash(password, 4);
    await prisma.user.create({
      data: {
        id: uid,
        login,
        email: `${login}@example.com`,
        passwordHash: hash,
        name: login,
        emailVerified: true,
        isActive: true,
      },
    });
    return uid;
  }

  beforeAll(async () => {
    const eph = await createEphemeralDatabase('auth-login');
    dropDb = eph.drop;
    execFileSync('npx', ['prisma', 'migrate', 'deploy'], {
      cwd: path.join(__dirname, '..', '..'),
      env: { ...process.env, DATABASE_URL: eph.url, DIRECT_URL: eph.url },
      stdio: 'inherit',
    });
    prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: eph.url }) });
    await prisma.$connect();
    jwt = new JwtService({ secret: JWT_SECRET });
    auth = new AuthService(
      prisma as never,
      jwt,
      new SessionDenyPushService(),
      new Require2faPolicyService(),
      new LoginAttemptStore(),
    );
  }, 180_000);

  afterAll(async () => {
    if (prisma) await prisma.$disconnect();
    if (dropDb) await dropDb();
  });

  it('loginWithMfa: valid credentials issue a JWT whose claims match the user row', async () => {
    const login = `login-${id('u')}`;
    const uid = await seedVerifiedUser(login);
    const result = await auth.loginWithMfa(login, PASSWORD, {
      deviceLabel: 'jest',
      ip: '10.0.0.1',
    });
    expect(result.mfaRequired).toBe(false);
    expect(result.auth?.accessToken).toBeTruthy();

    const claims = jwt.verify(result.auth!.accessToken, { secret: JWT_SECRET }) as JwtPayload;
    expect(claims.sub).toBe(uid);
    expect(claims.login).toBe(login);
    expect(claims.email).toBe(`${login}@example.com`.toLowerCase());
    expect(claims.jti).toBeTruthy();

    expect(await auth.isSessionValid(uid, claims.jti)).toBe(true);
    const session = await prisma.session.findFirst({ where: { userId: uid, tokenId: claims.jti } });
    expect(session?.deviceLabel).toBe('jest');
    expect(session?.revokedAt).toBeNull();
  });

  it('loginWithMfa: wrong password rejects without issuing a session (no enumeration leak)', async () => {
    const login = `badpw-${id('u')}`;
    const uid = await seedVerifiedUser(login);
    await expect(auth.loginWithMfa(login, 'wrong-password')).rejects.toMatchObject({
      errorCode: 'auth',
    });
    const sessions = await prisma.session.count({ where: { userId: uid } });
    expect(sessions).toBe(0);
  });

  it('validateAndLogin: email identifier works case-insensitively', async () => {
    const login = `email-${id('u')}`;
    const uid = await seedVerifiedUser(login);
    const authResult = await auth.validateAndLogin(`${login}@example.com`.toUpperCase(), PASSWORD);
    const claims = jwt.verify(authResult.accessToken, { secret: JWT_SECRET }) as JwtPayload;
    expect(claims.sub).toBe(uid);
  });

  it('logout revokes the session so isSessionValid becomes false (gateway deny-list)', async () => {
    const login = `logout-${id('u')}`;
    const uid = await seedVerifiedUser(login);
    const { auth: session } = (await auth.loginWithMfa(login, PASSWORD)) as {
      auth: NonNullable<Awaited<ReturnType<AuthService['loginWithMfa']>>['auth']>;
    };
    const claims = jwt.verify(session.accessToken, { secret: JWT_SECRET }) as JwtPayload;
    expect(await auth.isSessionValid(uid, claims.jti)).toBe(true);
    await auth.logout(uid, claims.jti);
    expect(await auth.isSessionValid(uid, claims.jti)).toBe(false);
  });

  it('unverified or inactive accounts cannot authenticate', async () => {
    const login = `inactive-${id('u')}`;
    const hash = await bcrypt.hash(PASSWORD, 4);
    await prisma.user.create({
      data: {
        id: id('user'),
        login,
        email: `${login}@example.com`,
        passwordHash: hash,
        name: login,
        emailVerified: false,
        isActive: true,
      },
    });
    await expect(auth.loginWithMfa(login, PASSWORD)).rejects.toBeInstanceOf(AppError);
  });
});
