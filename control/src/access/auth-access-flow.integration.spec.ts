import { execFileSync } from 'node:child_process';
import * as path from 'node:path';
import * as bcrypt from 'bcryptjs';
import { PrismaPg } from '@prisma/adapter-pg';
import { JwtService } from '@nestjs/jwt';
import { createEphemeralDatabase, describeIntegration, id } from '@fairflow/testing';
import { AuthService, type JwtPayload } from '../../../auth/src/auth/auth.service';
import { SessionDenyPushService } from '../../../auth/src/auth/session-deny-push.service';
import { Require2faPolicyService } from '../../../auth/src/auth/require2fa-policy.service';
import { LoginAttemptStore } from '../../../auth/src/auth/login-attempt-store.service';
import { PrismaClient as AuthPrismaClient } from '../../../auth/src/generated/prisma';
import { PrismaClient as ControlPrismaClient } from '../generated/prisma';
import type { PrismaService } from '../prisma/prisma.service';
import type { ProjectsService } from '../projects/projects.service';
import type { RoleAuditService } from '../outbox/role-audit.service';
import { OrgPdpService } from '../organizations/org-pdp.service';
import { RolesService, invalidateSystemRoleSync } from '../roles/roles.service';
import { PdpService } from '../roles/pdp.service';
import { VisibilityResolverService } from '../organizations/visibility-resolver.service';
import { ProjectAccessEpochService } from '../projects/project-access-epoch.service';

const SYSTEM_ID = 'system';
const JWT_SECRET = 'auth-access-flow-integration-secret-32b';

/**
 * End-to-end auth-access-flow integration (QA-CI T-036.2). One ephemeral Postgres
 * database with BOTH auth + control schemas migrated — exercises the real cross-domain
 * chain the gateway orchestrates:
 *
 *   login (auth) → JWT verify (gateway guard) → isSessionValid (auth deny-list)
 *   → checkPermissions (control PDP)
 *
 * No gRPC mocks at the workspace boundary: AuthService and PdpService are wired
 * directly against real Prisma clients, matching how production services call each
 * other through the gateway PEP.
 */
describeIntegration('auth-access-flow (login → JWT → session → PDP, real Postgres)', () => {
  let authPrisma: AuthPrismaClient;
  let controlPrisma: ControlPrismaClient;
  let auth: AuthService;
  let pdp: PdpService;
  let jwt: JwtService;
  let dropDb: () => Promise<void>;

  const PASSWORD = 'AccessFlow!Pass1';

  function wirePdp(): PdpService {
    const prismaSvc = controlPrisma as unknown as PrismaService;
    const projects = {
      findOne: async (projectId: string) => {
        const row = await controlPrisma.project.findUnique({ where: { id: projectId } });
        if (!row) throw new Error(`project ${projectId} not found`);
        return {
          ...row,
          effectiveModules: row.modules,
          modulePolicies: row.modulePolicies ?? [],
        };
      },
    } as unknown as ProjectsService;
    const roleAudit = {
      append: jest.fn().mockResolvedValue(undefined),
      appendInTx: jest.fn().mockResolvedValue(undefined),
    } as unknown as RoleAuditService;
    const roles = new RolesService(prismaSvc, projects, new OrgPdpService(prismaSvc), roleAudit);
    return new PdpService(
      roles,
      projects,
      new VisibilityResolverService(prismaSvc),
      new ProjectAccessEpochService(prismaSvc),
      prismaSvc,
    );
  }

  async function seedUser(login: string): Promise<string> {
    const uid = id('user');
    const hash = await bcrypt.hash(PASSWORD, 4);
    await authPrisma.user.create({
      data: {
        id: uid,
        login,
        email: `${login}@flow.test`,
        passwordHash: hash,
        name: login,
        emailVerified: true,
        isActive: true,
      },
    });
    return uid;
  }

  async function seedProjectForUser(userId: string, membershipRole: string): Promise<string> {
    await controlPrisma.systemSettings.upsert({
      where: { id: SYSTEM_ID },
      create: { id: SYSTEM_ID, name: 'System', slug: `sys-${id('s')}` },
      update: {},
    });
    const projectId = id('proj');
    await controlPrisma.project.create({
      data: {
        id: projectId,
        ownerId: SYSTEM_ID,
        name: 'Access flow',
        modules: ['deals', 'contacts'],
      },
    });
    await controlPrisma.projectMember.create({
      data: { id: id('pm'), projectId, userId, role: membershipRole },
    });
    return projectId;
  }

  beforeAll(async () => {
    const eph = await createEphemeralDatabase('auth-access-flow');
    dropDb = eph.drop;
    const backendRoot = path.join(__dirname, '..', '..', '..');
    for (const svc of ['auth', 'control'] as const) {
      execFileSync('npx', ['prisma', 'migrate', 'deploy'], {
        cwd: path.join(backendRoot, svc),
        env: { ...process.env, DATABASE_URL: eph.url, DIRECT_URL: eph.url },
        stdio: 'inherit',
      });
    }
    authPrisma = new AuthPrismaClient({ adapter: new PrismaPg({ connectionString: eph.url }) });
    controlPrisma = new ControlPrismaClient({
      adapter: new PrismaPg({ connectionString: eph.url }),
    });
    await Promise.all([authPrisma.$connect(), controlPrisma.$connect()]);
    jwt = new JwtService({ secret: JWT_SECRET });
    auth = new AuthService(
      authPrisma as never,
      jwt,
      new SessionDenyPushService(),
      new Require2faPolicyService(),
      new LoginAttemptStore(),
    );
    pdp = wirePdp();
  }, 240_000);

  afterAll(async () => {
    await Promise.all([authPrisma?.$disconnect(), controlPrisma?.$disconnect()]);
    if (dropDb) await dropDb();
  });

  beforeEach(() => {
    invalidateSystemRoleSync();
    pdp = wirePdp();
  });

  it('viewer: login → JWT → live session → PDP denies deals:delete', async () => {
    const login = `viewer-${id('u')}`;
    const userId = await seedUser(login);
    const projectId = await seedProjectForUser(userId, 'viewer');

    const loginResult = await auth.loginWithMfa(`${login}@flow.test`, PASSWORD);
    expect(loginResult.mfaRequired).toBe(false);
    const token = loginResult.auth!.accessToken;

    const claims = jwt.verify(token, { secret: JWT_SECRET }) as JwtPayload;
    expect(claims.sub).toBe(userId);
    expect(await auth.isSessionValid(userId, claims.jti)).toBe(true);

    const pdpResult = await pdp.checkPermissions({
      projectId,
      userId: claims.sub,
      checks: [{ subject: 'deals', action: 'delete' }],
    });
    expect(pdpResult.decisions[0].decision).toBe('deny');
    expect(pdpResult.decisions[0].notApplicable).toBe(false);
  });

  it('manager: same JWT chain allows deals:move the flat matrix permits', async () => {
    const login = `manager-${id('u')}`;
    const userId = await seedUser(login);
    const projectId = await seedProjectForUser(userId, 'manager');

    const { auth: session } = (await auth.loginWithMfa(login, PASSWORD)) as {
      auth: NonNullable<Awaited<ReturnType<AuthService['loginWithMfa']>>['auth']>;
    };
    const claims = jwt.verify(session.accessToken, { secret: JWT_SECRET }) as JwtPayload;

    const pdpResult = await pdp.checkPermissions({
      projectId,
      userId: claims.sub,
      checks: [{ subject: 'deals', action: 'move' }],
    });
    expect(pdpResult.decisions[0].decision).toBe('allow');
  });

  it('revoked session: logout before PDP still passes JWT crypto but isSessionValid fails', async () => {
    const login = `revoke-${id('u')}`;
    const userId = await seedUser(login);
    await seedProjectForUser(userId, 'admin');

    const { auth: session } = (await auth.loginWithMfa(login, PASSWORD)) as {
      auth: NonNullable<Awaited<ReturnType<AuthService['loginWithMfa']>>['auth']>;
    };
    const claims = jwt.verify(session.accessToken, { secret: JWT_SECRET }) as JwtPayload;
    expect(await auth.isSessionValid(userId, claims.jti)).toBe(true);

    await auth.logout(userId, claims.jti);
    expect(await auth.isSessionValid(userId, claims.jti)).toBe(false);
    // Gateway guard rejects before PDP when the deny-list says invalid — PDP is not reached.
  });

  it('owner: JWT subject receives OWNER_ALL from control PDP', async () => {
    const login = `owner-${id('u')}`;
    const userId = await seedUser(login);
    const projectId = await seedProjectForUser(userId, 'owner');

    const loginResult = await auth.loginWithMfa(login, PASSWORD);
    const claims = jwt.verify(loginResult.auth!.accessToken, { secret: JWT_SECRET }) as JwtPayload;

    const pdpResult = await pdp.checkPermissions({
      projectId,
      userId: claims.sub,
      checks: [{ subject: 'deals', action: 'manage' }],
    });
    expect(pdpResult.decisions[0].decision).toBe('allow');
    expect(pdpResult.decisions[0].reason).toBe('OWNER_ALL');
  });
});
