import { execFileSync } from 'node:child_process';
import * as path from 'node:path';
import { PrismaPg } from '@prisma/adapter-pg';
import {
  createEphemeralDatabase,
  describeIntegration,
  id,
  truncateTables,
} from '@fairflow/testing';
import { projectRoleCanKey, type PermissionAction } from '@fairflow/shared';
import { PrismaClient } from '../generated/prisma';
import type { PrismaService } from '../prisma/prisma.service';
import type { ProjectsService } from '../projects/projects.service';
import type { RoleAuditService } from '../outbox/role-audit.service';
import { OrgPdpService } from '../organizations/org-pdp.service';
import { RolesService, invalidateSystemRoleSync } from './roles.service';
import { PdpService } from './pdp.service';
import { VisibilityResolverService } from '../organizations/visibility-resolver.service';
import { ProjectAccessEpochService } from '../projects/project-access-epoch.service';

const SYSTEM_ID = 'system';

/**
 * Control PDP integration (QA-CI T-036.2, wave auth-access-flow). Real Postgres,
 * real RolesService + PdpService.checkPermissions — the control half of
 * gateway PEP → control PDP (TODO-027).
 *
 * Only ProjectsService.findOne is stubbed to read seeded rows from Prisma; the
 * RBAC engine, system-role sync, membership baseline and grant overlay run for real.
 */
describeIntegration('PdpService.checkPermissions (real Postgres RBAC)', () => {
  let prisma: PrismaClient;
  let pdp: PdpService;
  let dropDb: () => Promise<void>;

  function projectsAdapter(): ProjectsService {
    return {
      findOne: async (projectId: string) => {
        const row = await prisma.project.findUnique({ where: { id: projectId } });
        if (!row) throw new Error(`project ${projectId} not found`);
        return {
          ...row,
          effectiveModules: row.modules,
          modulePolicies: row.modulePolicies ?? [],
        };
      },
    } as unknown as ProjectsService;
  }

  function wirePdp(): PdpService {
    const prismaSvc = prisma as unknown as PrismaService;
    const projects = projectsAdapter();
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

  async function seedProject(modules: string[]): Promise<string> {
    await prisma.systemSettings.upsert({
      where: { id: SYSTEM_ID },
      create: { id: SYSTEM_ID, name: 'System', slug: `sys-${id('s')}` },
      update: {},
    });
    const projectId = id('proj');
    await prisma.project.create({
      data: {
        id: projectId,
        ownerId: SYSTEM_ID,
        name: 'RBAC test',
        modules,
      },
    });
    return projectId;
  }

  async function addMember(projectId: string, userId: string, role: string): Promise<void> {
    await prisma.projectMember.create({
      data: { id: id('pm'), projectId, userId, role },
    });
  }

  beforeAll(async () => {
    const eph = await createEphemeralDatabase('control-pdp');
    dropDb = eph.drop;
    execFileSync('npx', ['prisma', 'migrate', 'deploy'], {
      cwd: path.join(__dirname, '..', '..'),
      env: { ...process.env, DATABASE_URL: eph.url, DIRECT_URL: eph.url },
      stdio: 'inherit',
    });
    prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: eph.url }) });
    await prisma.$connect();
    pdp = wirePdp();
  }, 180_000);

  afterAll(async () => {
    if (prisma) await prisma.$disconnect();
    if (dropDb) await dropDb();
  });

  beforeEach(async () => {
    invalidateSystemRoleSync();
    await truncateTables(prisma, [
      '"control"."PermissionGrant"',
      '"control"."RoleAssignment"',
      '"control"."RolePermission"',
      '"control"."Role"',
      '"control"."ProjectMember"',
      '"control"."ProjectAccessEpoch"',
      '"control"."Project"',
      '"control"."system_settings"',
    ]);
    pdp = wirePdp();
  });

  async function check(
    projectId: string,
    userId: string,
    subject: string,
    action: PermissionAction,
  ) {
    const result = await pdp.checkPermissions({
      projectId,
      userId,
      checks: [{ subject, action }],
    });
    return result.decisions[0];
  }

  it('viewer membership baseline: deals:read allowed, deals:delete denied', async () => {
    const projectId = await seedProject(['deals', 'contacts']);
    const userId = id('user');
    await addMember(projectId, userId, 'viewer');

    expect((await check(projectId, userId, 'deals', 'read')).decision).toBe('allow');
    expect((await check(projectId, userId, 'deals', 'delete')).decision).toBe('deny');
  });

  it('manager membership baseline matches the flat role×action matrix', async () => {
    const projectId = await seedProject(['deals', 'contacts', 'orders']);
    const userId = id('user');
    await addMember(projectId, userId, 'manager');

    expect(projectRoleCanKey('manager', 'deals', 'move')).toBe(true);
    expect((await check(projectId, userId, 'deals', 'move')).decision).toBe('allow');
    expect((await check(projectId, userId, 'roles', 'manage')).decision).toBe('deny');
  });

  it('project owner short-circuits to OWNER_ALL for every check', async () => {
    const projectId = await seedProject(['deals']);
    const ownerId = id('user');
    await addMember(projectId, ownerId, 'owner');

    const verdict = await check(projectId, ownerId, 'deals', 'delete');
    expect(verdict.decision).toBe('allow');
    expect(verdict.reason).toBe('OWNER_ALL');
  });

  it('addressed deny grant beats membership allow (deny > allow)', async () => {
    const projectId = await seedProject(['contacts']);
    const userId = id('user');
    await addMember(projectId, userId, 'manager');

    await prisma.permissionGrant.create({
      data: {
        id: id('grant'),
        projectId,
        moduleId: 'contacts',
        effect: 'deny',
        subject: 'contacts',
        action: 'export',
        resource: '*',
        granteeType: 'member',
        granteeId: userId,
        createdBy: userId,
      },
    });
    invalidateSystemRoleSync(projectId);
    pdp = wirePdp();

    expect((await check(projectId, userId, 'contacts', 'export')).decision).toBe('deny');
  });

  it('returns notApplicable for a pair absent from the project catalog', async () => {
    const projectId = await seedProject(['contacts']);
    const userId = id('user');
    await addMember(projectId, userId, 'admin');

    // `deals:read` is still in the system catalog even if deals is off — use an
    // action no module declares (same pair as pdp.check-permissions.spec.ts).
    const result = await pdp.checkPermissions({
      projectId,
      userId,
      checks: [{ subject: 'statistics', action: 'purge' }],
    });
    expect(result.decisions[0].notApplicable).toBe(true);
    expect(result.decisions[0].reason).toBe('NO_CATALOG_KEY');
  });

  it('stamps decisions with a monotonic access epoch', async () => {
    const projectId = await seedProject(['deals']);
    const userId = id('user');
    await addMember(projectId, userId, 'member');

    const first = await pdp.checkPermissions({
      projectId,
      userId,
      checks: [{ subject: 'deals', action: 'read' }],
    });
    // No ProjectAccessEpoch row yet — get() documents 0 as the stable baseline.
    expect(first.epoch).toBe(0);

    const epochSvc = new ProjectAccessEpochService(prisma as unknown as PrismaService);
    await epochSvc.bump(projectId);
    pdp = wirePdp();

    const second = await pdp.checkPermissions({
      projectId,
      userId,
      checks: [{ subject: 'deals', action: 'read' }],
    });
    expect(second.epoch).toBeGreaterThan(first.epoch);
  });
});
