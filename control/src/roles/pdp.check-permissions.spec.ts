import { PdpService } from './pdp.service';
import { RolesService } from './roles.service';
import { ProjectsService } from '../projects/projects.service';
import { VisibilityResolverService } from '../organizations/visibility-resolver.service';
import { ProjectAccessEpochService } from '../projects/project-access-epoch.service';
import { PrismaService } from '../prisma/prisma.service';
import {
  ALL_MODULE_IDS,
  buildProjectCatalogWithSystem,
  compileEffectivePermissions,
  expandSystemRolePermissions,
  projectRoleCanKey,
  PROJECT_ROLES,
  type EffectivePermissionSet,
  type PermissionAction,
  type PermissionCatalog,
  type ProjectRole,
} from '@fairflow/shared';

/**
 * TODO-027 — control side of the PEP↔PDP seam: `PdpService.checkPermissions` is
 * the ONE decision the gateway asks for on every @RequirePermission route.
 *
 * The suite runs the REAL engine (`decideRbac` via checkPermissions, the real
 * catalog built from the module manifests, the real effective-set compiler with
 * its deny>allow rule); only prisma / roles-service plumbing is doubled.
 *
 * It pins the four properties the enforcement path must have:
 *   1. base roles decide exactly as the gateway's flat matrix did;
 *   2. a custom role that lacks a key really denies it;
 *   3. deny beats allow in every source (grant vs role, grant vs grant);
 *   4. a pair with no catalog key is reported `notApplicable` (the engine has no
 *      opinion) instead of silently 403-ing a live route.
 */

const PROJECT = 'proj-1';
const CATALOG: PermissionCatalog = buildProjectCatalogWithSystem(ALL_MODULE_IDS);
const CATALOG_KEYS = new Set<string>(CATALOG.keys);

/** PdpService wired to fixed effective sets (the real decision code runs). */
function buildPdp(opts: {
  users: Record<
    string,
    { effective: EffectivePermissionSet; role: string; member?: 'owner' | 'member' | null }
  >;
  epoch?: number;
}): PdpService {
  const roles = {
    resolveEffective: async (_projectId: string, userId: string) => {
      const u = opts.users[userId];
      const effective = u?.effective ?? { allow: [], deny: [] };
      return {
        allow: effective.allow,
        deny: effective.deny,
        role: u?.role ?? '',
        effective,
        catalog: CATALOG,
      };
    },
    getCatalog: async () => CATALOG,
  } as unknown as RolesService;

  const projects = { findOne: async () => ({ modulePolicies: [] }) } as unknown as ProjectsService;
  const visibility = {} as unknown as VisibilityResolverService;
  const accessEpoch = {
    get: async () => opts.epoch ?? 42,
  } as unknown as ProjectAccessEpochService;
  const prisma = {
    projectMember: {
      findUnique: async ({ where }: { where: { projectId_userId: { userId: string } } }) => {
        const u = opts.users[where.projectId_userId.userId];
        return u?.member ? { role: u.member } : null;
      },
    },
    project: { findUnique: async () => ({ ownerId: '' }) },
    employee: { findMany: async () => [] },
  } as unknown as PrismaService;

  return new PdpService(roles, projects, visibility, accessEpoch, prisma);
}

/** Effective set of a plain base role, exactly as control materializes it. */
function baseRoleEffective(role: ProjectRole): EffectivePermissionSet {
  return compileEffectivePermissions(
    [{ permissionKeys: expandSystemRolePermissions(role, CATALOG) }],
    [],
    CATALOG_KEYS,
  );
}

describe('PdpService.checkPermissions (TODO-027)', () => {
  // ── 1. base-role compatibility ──────────────────────────────────────────────

  describe('base roles decide as the flat role×action matrix', () => {
    /**
     * Representative "role × subject × action" table. The exhaustive version
     * (every @RequirePermission pair actually mounted on the gateway) lives in
     * gateway/src/guards/permission-parity.spec.ts; this one keeps the contract
     * visible on the control side too.
     */
    const pairs: Array<[string, PermissionAction]> = [
      ['deals', 'read'],
      ['deals', 'write'],
      ['deals', 'delete'],
      ['deals', 'move'],
      ['deals', 'manage'],
      ['contacts', 'read'],
      ['contacts', 'import'],
      ['contacts', 'export'],
      ['orders', 'move'],
      ['companies', 'execute'],
      ['documents.generate', 'execute'],
      ['project', 'manage'],
      ['roles', 'manage'],
    ];

    it.each(PROJECT_ROLES)('role %s', async (role) => {
      const pdp = buildPdp({
        users: { u: { effective: baseRoleEffective(role), role, member: 'member' } },
      });
      const res = await pdp.checkPermissions({
        projectId: PROJECT,
        userId: 'u',
        checks: pairs.map(([subject, action]) => ({ subject, action })),
      });
      const got = res.decisions.map((d) => `${d.subject}:${d.action}=${d.decision}`);
      const want = pairs.map(
        ([subject, action]) =>
          `${subject}:${action}=${projectRoleCanKey(role, subject, action) ? 'allow' : 'deny'}`,
      );
      expect(got).toEqual(want);
    });

    it('the project owner is allowed everything (RFC «owner: всё», as in simulateExplain)', async () => {
      const pdp = buildPdp({
        // No materialized role rows at all — a fresh project (D10).
        users: { u: { effective: { allow: [], deny: [] }, role: '', member: 'owner' } },
      });
      const res = await pdp.checkPermissions({
        projectId: PROJECT,
        userId: 'u',
        checks: [
          { subject: 'deals', action: 'delete' },
          { subject: 'project', action: 'manage' },
        ],
      });
      expect(res.decisions.map((d) => d.decision)).toEqual(['allow', 'allow']);
      expect(res.decisions.every((d) => d.reason === 'OWNER_ALL')).toBe(true);
      expect(res.role).toBe('owner');
    });

    it('a non-member gets deny for everything (least privilege default)', async () => {
      const pdp = buildPdp({ users: {} });
      const res = await pdp.checkPermissions({
        projectId: PROJECT,
        userId: 'stranger',
        checks: [{ subject: 'deals', action: 'read' }],
      });
      expect(res.decisions[0]).toMatchObject({
        decision: 'deny',
        reason: 'NOT_IN_ANY_ROLE',
        notApplicable: false,
      });
    });
  });

  // ── 2. custom roles are really enforced ─────────────────────────────────────

  it('a custom role built on manager MINUS deals:delete denies the delete', async () => {
    const managerKeys = expandSystemRolePermissions('manager', CATALOG).filter(
      (k) => k !== 'deals:delete',
    );
    // The user is a plain `member` in ProjectMember (so the membership baseline
    // does not re-grant delete) and carries the custom role by assignment.
    const effective = compileEffectivePermissions(
      [
        { permissionKeys: expandSystemRolePermissions('member', CATALOG) },
        { permissionKeys: managerKeys },
      ],
      [],
      CATALOG_KEYS,
    );
    const pdp = buildPdp({ users: { u: { effective, role: 'member', member: 'member' } } });
    const res = await pdp.checkPermissions({
      projectId: PROJECT,
      userId: 'u',
      checks: [
        { subject: 'deals', action: 'delete' },
        { subject: 'deals', action: 'write' },
      ],
    });
    expect(res.decisions[0]).toMatchObject({ decision: 'deny', reason: 'NOT_IN_ANY_ROLE' });
    // …and the rest of the custom role still works.
    expect(res.decisions[1].decision).toBe('allow');
  });

  it('a module-scoped role assignment cannot reach another module', async () => {
    const effective = compileEffectivePermissions(
      [{ permissionKeys: expandSystemRolePermissions('manager', CATALOG), moduleScope: 'deals' }],
      [],
      CATALOG_KEYS,
    );
    const pdp = buildPdp({ users: { u: { effective, role: 'manager', member: null } } });
    const res = await pdp.checkPermissions({
      projectId: PROJECT,
      userId: 'u',
      checks: [
        { subject: 'deals', action: 'delete' },
        { subject: 'contacts', action: 'delete' },
      ],
    });
    expect(res.decisions.map((d) => d.decision)).toEqual(['allow', 'deny']);
  });

  // ── 3. deny > allow ─────────────────────────────────────────────────────────

  describe('deny strictly beats allow', () => {
    it('a deny-grant overrides the role that grants the key', async () => {
      const effective = compileEffectivePermissions(
        [{ permissionKeys: expandSystemRolePermissions('manager', CATALOG) }],
        [{ effect: 'deny', key: 'contacts:export' }],
        CATALOG_KEYS,
      );
      const pdp = buildPdp({ users: { u: { effective, role: 'manager', member: 'member' } } });
      const res = await pdp.checkPermissions({
        projectId: PROJECT,
        userId: 'u',
        checks: [{ subject: 'contacts', action: 'export' }],
      });
      expect(res.decisions[0]).toMatchObject({
        decision: 'deny',
        reason: 'DENIED_BY_GRANT',
        notApplicable: false,
      });
    });

    it('conflicting grants on the same key resolve to deny (both orders)', async () => {
      for (const grants of [
        [
          { effect: 'allow' as const, key: 'deals:delete' },
          { effect: 'deny' as const, key: 'deals:delete' },
        ],
        [
          { effect: 'deny' as const, key: 'deals:delete' },
          { effect: 'allow' as const, key: 'deals:delete' },
        ],
      ]) {
        const effective = compileEffectivePermissions(
          [{ permissionKeys: expandSystemRolePermissions('member', CATALOG) }],
          grants,
          CATALOG_KEYS,
        );
        const pdp = buildPdp({ users: { u: { effective, role: 'member', member: 'member' } } });
        const res = await pdp.checkPermissions({
          projectId: PROJECT,
          userId: 'u',
          checks: [{ subject: 'deals', action: 'delete' }],
        });
        expect(res.decisions[0]).toMatchObject({
          decision: 'deny',
          reason: 'DENIED_BY_GRANT',
        });
      }
    });

    it('a multi-key decorator mapping denies if ANY mapped key is denied', async () => {
      // companies:execute (merge) maps to companies:write ∧ companies:delete.
      const effective = compileEffectivePermissions(
        [{ permissionKeys: expandSystemRolePermissions('manager', CATALOG) }],
        [{ effect: 'deny', key: 'companies:delete' }],
        CATALOG_KEYS,
      );
      const pdp = buildPdp({ users: { u: { effective, role: 'manager', member: 'member' } } });
      const res = await pdp.checkPermissions({
        projectId: PROJECT,
        userId: 'u',
        checks: [{ subject: 'companies', action: 'execute' }],
      });
      expect(res.decisions[0].decision).toBe('deny');
    });
  });

  // ── 4. abstain contract + envelope ──────────────────────────────────────────

  describe('pairs with no catalog key', () => {
    it('are reported notApplicable, not as a granular deny', async () => {
      const pdp = buildPdp({
        users: {
          u: { effective: baseRoleEffective('manager'), role: 'manager', member: 'member' },
        },
      });
      // `statistics:export` was the historical example here, but TODO-089/110
      // put it into the catalog — use an action no module declares instead.
      const res = await pdp.checkPermissions({
        projectId: PROJECT,
        userId: 'u',
        checks: [{ subject: 'statistics', action: 'purge' }],
      });
      expect(res.decisions[0]).toMatchObject({
        decision: 'deny',
        reason: 'NO_CATALOG_KEY',
        notApplicable: true,
      });
    });

    it('a real granular deny is never marked notApplicable', async () => {
      const pdp = buildPdp({
        users: { u: { effective: baseRoleEffective('viewer'), role: 'viewer', member: 'member' } },
      });
      const res = await pdp.checkPermissions({
        projectId: PROJECT,
        userId: 'u',
        checks: [{ subject: 'deals', action: 'write' }],
      });
      expect(res.decisions[0].notApplicable).toBe(false);
    });
  });

  it('stamps the project access epoch so the PEP can cache under K3', async () => {
    const pdp = buildPdp({
      users: { u: { effective: baseRoleEffective('member'), role: 'member', member: 'member' } },
      epoch: 99,
    });
    const res = await pdp.checkPermissions({
      projectId: PROJECT,
      userId: 'u',
      checks: [{ subject: 'deals', action: 'read' }],
    });
    expect(res.epoch).toBe(99);
  });

  it('answers a batch in one resolve, echoing subject/action per decision', async () => {
    const pdp = buildPdp({
      users: { u: { effective: baseRoleEffective('member'), role: 'member', member: 'member' } },
    });
    const checks = [
      { subject: 'deals', action: 'read' },
      { subject: 'deals', action: 'delete' },
      { subject: 'contacts', action: 'write' },
    ];
    const res = await pdp.checkPermissions({ projectId: PROJECT, userId: 'u', checks });
    expect(res.decisions.map((d) => ({ subject: d.subject, action: d.action }))).toEqual(checks);
    expect(res.decisions.map((d) => d.decision)).toEqual(['allow', 'deny', 'allow']);
  });

  it('rejects an unusable request instead of answering allow', async () => {
    const pdp = buildPdp({ users: {} });
    await expect(
      pdp.checkPermissions({ projectId: '', userId: 'u', checks: [] }),
    ).rejects.toBeTruthy();
    await expect(
      pdp.checkPermissions({ projectId: PROJECT, userId: '', checks: [] }),
    ).rejects.toBeTruthy();
  });

  it('drops malformed checks rather than deciding on empty pairs', async () => {
    const pdp = buildPdp({
      users: { u: { effective: baseRoleEffective('member'), role: 'member', member: 'member' } },
    });
    const res = await pdp.checkPermissions({
      projectId: PROJECT,
      userId: 'u',
      checks: [
        { subject: '', action: 'read' },
        { subject: 'deals', action: '' },
      ],
    });
    // No verdict for a malformed pair ⇒ the PEP sees "no decision" ⇒ denies.
    expect(res.decisions).toEqual([]);
  });
});
