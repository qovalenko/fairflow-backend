import { execFileSync } from 'node:child_process';
import * as path from 'node:path';
import { PrismaPg } from '@prisma/adapter-pg';
import { JwtService } from '@nestjs/jwt';
import { createEphemeralDatabase, describeIntegration, id } from '@fairflow/testing';
import { PrismaClient } from '../generated/prisma';
import { AuthService } from './auth.service';
import { ProfileService } from './profile.service';
import type { ProfileEventsService } from './profile-events.service';
import { SessionDenyPushService } from './session-deny-push.service';
import { Require2faPolicyService } from './require2fa-policy.service';
import { LoginAttemptStore } from './login-attempt-store.service';

/**
 * Auth Postgres integration (QA-CI T-036.1, wave 1). Self-skips via
 * describeIntegration unless TEST_DATABASE_URL is set — so the unit/component
 * pass stays green without a DB; the CI `test:integration` job provides a real
 * Postgres `service:` and this suite spins up its own throwaway `qa_infra_*`
 * database, applies the auth migrations, and exercises the SESSION / JTI
 * deny-list / TTL semantics against real rows (the parts a mock cannot prove):
 *   - issueToken persists a Session keyed by the token's jti;
 *   - isSessionValid: live→valid, revoked→invalid, expired→invalid, untracked→valid;
 *   - logout / revokeOtherSessions / revokeAllSessionsForUsers really flip rows;
 *   - user isolation: one user's revoke never touches another user's sessions.
 */
describeIntegration('auth sessions (real Postgres)', () => {
  let prisma: PrismaClient;
  let auth: AuthService;
  let profile: ProfileService;
  let dropDb: () => Promise<void>;

  const events = {
    passwordChanged: jest.fn(),
    emailChangeRequested: jest.fn(),
    emailChanged: jest.fn(),
    twoFactorEnabled: jest.fn(),
    twoFactorDisabled: jest.fn(),
    sessionRevoked: jest.fn(),
  } as unknown as ProfileEventsService;

  const jwt = new JwtService({ secret: 'integration-test-secret-min-32-chars-000' });

  /** Insert a user directly (bypassing bcrypt cost) and return its id. */
  async function seedUser(login: string): Promise<string> {
    const uid = id('user');
    await prisma.user.create({
      data: {
        id: uid,
        login,
        email: `${login}@example.com`,
        passwordHash: 'x',
        name: login,
      },
    });
    return uid;
  }

  beforeAll(async () => {
    const eph = await createEphemeralDatabase('auth');
    dropDb = eph.drop;
    execFileSync('npx', ['prisma', 'migrate', 'deploy'], {
      cwd: path.join(__dirname, '..', '..'),
      env: { ...process.env, DATABASE_URL: eph.url, DIRECT_URL: eph.url },
      stdio: 'inherit',
    });
    prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: eph.url }) });
    await prisma.$connect();
    const denyPush = new SessionDenyPushService();
    const require2faPolicy = new Require2faPolicyService();
    const loginAttempts = new LoginAttemptStore();
    auth = new AuthService(prisma as never, jwt, denyPush, require2faPolicy, loginAttempts);
    profile = new ProfileService(prisma as never, jwt, events, denyPush, require2faPolicy);
  }, 180_000);

  afterAll(async () => {
    if (prisma) await prisma.$disconnect();
    if (dropDb) await dropDb();
  });

  it('issueToken persists a Session row keyed by the jti', async () => {
    const uid = await seedUser('sess-issue');
    const profileRow = await auth.me(uid);
    expect(profileRow).not.toBeNull();
    const result = await auth.issueToken(profileRow!, { deviceLabel: 'Chrome', ip: '1.2.3.4' });
    expect(result.accessToken).toBeTruthy();
    const rows = await prisma.session.findMany({ where: { userId: uid } });
    expect(rows).toHaveLength(1);
    expect(rows[0].deviceLabel).toBe('Chrome');
    expect(rows[0].revokedAt).toBeNull();
    expect(rows[0].expiresAt.getTime()).toBeGreaterThan(Date.now());
  });

  it('isSessionValid: live session valid; explicit revoke makes it invalid (deny-list)', async () => {
    const uid = await seedUser('sess-deny');
    const jti = id('jti');
    await prisma.session.create({
      data: {
        id: id('sess'),
        userId: uid,
        tokenId: jti,
        expiresAt: new Date(Date.now() + 60_000),
      },
    });
    expect(await auth.isSessionValid(uid, jti)).toBe(true);
    await auth.logout(uid, jti); // revoke by jti
    expect(await auth.isSessionValid(uid, jti)).toBe(false);
    // row really flipped
    const row = await prisma.session.findFirst({ where: { userId: uid, tokenId: jti } });
    expect(row?.revokedAt).not.toBeNull();
  });

  it('isSessionValid: an EXPIRED session (past expiresAt) is invalid (TTL)', async () => {
    const uid = await seedUser('sess-ttl');
    const jti = id('jti');
    await prisma.session.create({
      data: {
        id: id('sess'),
        userId: uid,
        tokenId: jti,
        expiresAt: new Date(Date.now() - 1000), // already expired
      },
    });
    expect(await auth.isSessionValid(uid, jti)).toBe(false);
  });

  it('isSessionValid: an UNTRACKED token (no row) is treated valid (fail-open on infra)', async () => {
    const uid = await seedUser('sess-untracked');
    expect(await auth.isSessionValid(uid, id('jti-never-stored'))).toBe(true);
  });

  it('revokeAllSessionsForUsers isolates by user — never revokes another user’s sessions', async () => {
    const userA = await seedUser('cascade-a');
    const userB = await seedUser('cascade-b');
    for (const uid of [userA, userA, userB]) {
      await prisma.session.create({
        data: {
          id: id('sess'),
          userId: uid,
          tokenId: id('jti'),
          expiresAt: new Date(Date.now() + 60_000),
        },
      });
    }
    const revoked = await profile.revokeAllSessionsForUsers([userA]);
    expect(revoked).toBe(2);
    // A's sessions revoked, B's untouched
    const aLive = await prisma.session.count({ where: { userId: userA, revokedAt: null } });
    const bLive = await prisma.session.count({ where: { userId: userB, revokedAt: null } });
    expect(aLive).toBe(0);
    expect(bLive).toBe(1);
  });

  it('revokeOtherSessions preserves the current session and revokes the rest', async () => {
    const uid = await seedUser('revoke-others');
    const current = id('jti-current');
    await prisma.session.create({
      data: {
        id: id('sess'),
        userId: uid,
        tokenId: current,
        expiresAt: new Date(Date.now() + 60_000),
      },
    });
    await prisma.session.create({
      data: {
        id: id('sess'),
        userId: uid,
        tokenId: id('jti'),
        expiresAt: new Date(Date.now() + 60_000),
      },
    });
    const n = await profile.revokeOtherSessions(uid, current);
    expect(n).toBe(1);
    // current still live, valid
    expect(await auth.isSessionValid(uid, current)).toBe(true);
  });
});
