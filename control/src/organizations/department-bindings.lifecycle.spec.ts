import { DepartmentBindingsService } from './department-bindings.service';
import { OrgStructureService } from './org-structure.service';
import { InvitationService } from './invitations.service';
import { OrgAuditService } from './org-audit.service';
import { OrgPdpService } from './org-pdp.service';
import { SeatsService } from './seats.service';
import { ProjectAccessEpochService } from '../projects/project-access-epoch.service';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Curator review follow-ups for department→project bindings:
 *  - Замечание 1 (deleteDepartment): removing a department must tear down its
 *    bindings + materialized source='binding' members (no FK → they would
 *    otherwise dangle as access from a department that no longer exists); manual
 *    memberships survive; touched projects get an epoch bump.
 *  - Замечание 2 (invitation.accept, FR-MORG-24): accepting an invite whose
 *    department is bound to a project materializes the binding membership
 *    (source='binding', role=defaultRole), running AFTER projectGrants so an
 *    explicit grant on the same project wins (the hook never overwrites).
 *
 * A hand-rolled in-memory Prisma fake backs the REAL services (no DB); its
 * $transaction runs the callback against the same store so tx-atomic writes are
 * observable end-to-end.
 */

type Rec = Record<string, unknown>;

function makePrisma(seed: {
  departments?: Rec[];
  projects?: Rec[];
  bindings?: Rec[];
  members?: Rec[];
  employees?: Rec[];
  invitations?: Rec[];
}) {
  const departments = seed.departments ?? [];
  const projects = seed.projects ?? [];
  const bindings = seed.bindings ?? [];
  const members = seed.members ?? [];
  const employees = seed.employees ?? [];
  const invitations = seed.invitations ?? [];

  const store = {
    systemSettings: {
      findUnique: ({ where }: { where: Rec }) =>
        Promise.resolve({ id: where.id as string, isActive: true }),
    },
    department: {
      findUnique: ({ where }: { where: Rec }) =>
        Promise.resolve(departments.find((d) => d.id === where.id) ?? null),
      count: ({ where }: { where: Rec }) => {
        if (where.parentId !== undefined) {
          return Promise.resolve(departments.filter((d) => d.parentId === where.parentId).length);
        }
        return Promise.resolve(0);
      },
      updateMany: ({ where, data }: { where: Rec; data: Rec }) => {
        for (const d of departments) {
          if (where.parentId !== undefined && d.parentId === where.parentId) {
            Object.assign(d, data);
          }
        }
        return Promise.resolve({ count: 0 });
      },
      delete: ({ where }: { where: Rec }) => {
        const i = departments.findIndex((d) => d.id === where.id);
        const [row] = departments.splice(i, 1);
        return Promise.resolve(row);
      },
    },
    project: {
      findMany: ({ where }: { where: Rec }) => {
        const ids = (where.id as { in: string[] }).in;
        return Promise.resolve(
          projects.filter(
            (p) =>
              ids.includes(p.id as string) &&
              (where.ownerType === undefined || p.ownerType === where.ownerType) &&
              (where.ownerId === undefined || p.ownerId === where.ownerId),
          ),
        );
      },
    },
    departmentProjectBinding: {
      findMany: ({ where }: { where: Rec }) =>
        Promise.resolve(
          bindings
            .filter(
              (b) =>
                (where.departmentId === undefined || b.departmentId === where.departmentId) &&
                (where.status === undefined || b.status === where.status) &&
                (where.scope === undefined || b.scope === where.scope),
            )
            .map((b) => ({ ...b })),
        ),
      delete: ({ where }: { where: Rec }) => {
        const i = bindings.findIndex((b) => b.id === where.id);
        const [row] = bindings.splice(i, 1);
        return Promise.resolve(row);
      },
    },
    employee: {
      findUnique: ({ where }: { where: Rec }) => {
        const key = where.organizationId_userId as { organizationId: string; userId: string };
        return Promise.resolve(
          employees.find((e) => e.organizationId === key.organizationId && e.userId === key.userId)
            ? {
                ...employees.find(
                  (e) => e.organizationId === key.organizationId && e.userId === key.userId,
                )!,
              }
            : null,
        );
      },
      findMany: ({ where }: { where: Rec }) =>
        Promise.resolve(
          employees.filter(
            (e) => e.departmentId === where.departmentId && e.isActive === where.isActive,
          ),
        ),
      count: ({ where }: { where: Rec }) =>
        Promise.resolve(
          employees.filter(
            (e) =>
              (where.departmentId === undefined || e.departmentId === where.departmentId) &&
              (where.isActive === undefined || e.isActive === where.isActive),
          ).length,
        ),
      updateMany: ({ where, data }: { where: Rec; data: Rec }) => {
        let count = 0;
        for (const e of employees) {
          const deptMatch =
            where.departmentId === undefined || e.departmentId === where.departmentId;
          const activeMatch = where.isActive === undefined || e.isActive === where.isActive;
          if (deptMatch && activeMatch) {
            Object.assign(e, data);
            count++;
          }
        }
        return Promise.resolve({ count });
      },
      upsert: ({ where, create, update }: { where: Rec; create: Rec; update: Rec }) => {
        const key = where.organizationId_userId as { organizationId: string; userId: string };
        const ex = employees.find(
          (e) => e.organizationId === key.organizationId && e.userId === key.userId,
        );
        if (ex) {
          for (const [k, v] of Object.entries(update)) if (v !== undefined) ex[k] = v;
          return Promise.resolve({ ...ex });
        }
        const row = { ...create };
        employees.push(row);
        return Promise.resolve({ ...row });
      },
    },
    projectMember: {
      findUnique: ({ where }: { where: Rec }) => {
        const key = where.projectId_userId as { projectId: string; userId: string };
        const found = members.find((m) => m.projectId === key.projectId && m.userId === key.userId);
        return Promise.resolve(found ? { ...found } : null);
      },
      findMany: ({ where }: { where: Rec }) =>
        Promise.resolve(
          members.filter(
            (m) =>
              (where.userId === undefined || m.userId === where.userId) &&
              (where.source === undefined || m.source === where.source) &&
              (where.bindingId === undefined || m.bindingId === where.bindingId) &&
              (where.departmentId === undefined || m.departmentId === where.departmentId),
          ),
        ),
      create: ({ data }: { data: Rec }) => {
        const row = { ...data };
        members.push(row);
        return Promise.resolve(row);
      },
      upsert: ({ where, create, update }: { where: Rec; create: Rec; update: Rec }) => {
        const key = where.projectId_userId as { projectId: string; userId: string };
        const ex = members.find((m) => m.projectId === key.projectId && m.userId === key.userId);
        if (ex) {
          Object.assign(ex, update);
          return Promise.resolve({ ...ex });
        }
        const row = { ...create };
        members.push(row);
        return Promise.resolve({ ...row });
      },
      deleteMany: ({ where }: { where: Rec }) => {
        const before = members.length;
        for (let i = members.length - 1; i >= 0; i--) {
          const m = members[i];
          if (
            (where.bindingId === undefined || m.bindingId === where.bindingId) &&
            (where.source === undefined || m.source === where.source) &&
            (where.userId === undefined || m.userId === where.userId) &&
            (where.departmentId === undefined || m.departmentId === where.departmentId)
          ) {
            members.splice(i, 1);
          }
        }
        return Promise.resolve({ count: before - members.length });
      },
    },
    invitation: {
      findUnique: ({ where }: { where: Rec }) =>
        Promise.resolve(
          invitations.find((iv) =>
            where.token !== undefined ? iv.token === where.token : iv.id === where.id,
          ) ?? null,
        ),
      update: ({ where, data }: { where: Rec; data: Rec }) => {
        const row = invitations.find((iv) => iv.id === where.id)!;
        Object.assign(row, data);
        return Promise.resolve(row);
      },
      updateMany: ({ where, data }: { where: Rec; data: Rec }) => {
        const notId = (where.id as { not?: string } | undefined)?.not;
        let count = 0;
        for (const iv of invitations) {
          if (
            (where.organizationId === undefined || iv.organizationId === where.organizationId) &&
            (where.email === undefined || iv.email === where.email) &&
            (where.status === undefined || iv.status === where.status) &&
            (notId === undefined || iv.id !== notId)
          ) {
            Object.assign(iv, data);
            count++;
          }
        }
        return Promise.resolve({ count });
      },
    },
    $transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn(store),
  };
  return {
    prisma: store as unknown as PrismaService,
    tables: { departments, bindings, members, employees, invitations },
  };
}

function makeBindings(prisma: PrismaService): DepartmentBindingsService {
  const pdp = { can: jest.fn(), canManage: jest.fn() } as unknown as OrgPdpService;
  const audit = { record: jest.fn().mockResolvedValue(undefined) } as unknown as OrgAuditService;
  const epoch = {
    bump: jest.fn().mockResolvedValue(undefined),
  } as unknown as ProjectAccessEpochService;
  return new DepartmentBindingsService(prisma, audit, pdp, epoch);
}

const ORG = 'org-1';
const DEPT = 'dept-1';
const PROJ = 'proj-1';

describe('OrgStructureService.deleteDepartment — binding teardown (review #1)', () => {
  it('removes the bindings + source="binding" members, keeps manual, bumps epoch', async () => {
    const { prisma, tables } = makePrisma({
      departments: [{ id: DEPT, organizationId: ORG }],
      bindings: [
        {
          id: 'b1',
          organizationId: ORG,
          departmentId: DEPT,
          projectId: PROJ,
          defaultRole: 'member',
          scope: 'self',
          status: 'active',
        },
      ],
      members: [
        {
          id: 'pm1',
          projectId: PROJ,
          userId: 'u1',
          role: 'member',
          source: 'binding',
          bindingId: 'b1',
          departmentId: DEPT,
        },
        {
          id: 'pm2',
          projectId: PROJ,
          userId: 'u2',
          role: 'member',
          source: 'binding',
          bindingId: 'b1',
          departmentId: DEPT,
        },
        { id: 'pm-manual', projectId: PROJ, userId: 'u9', role: 'admin', source: 'manual' },
      ],
    });
    const bindings = makeBindings(prisma);
    const pdp = { canManage: jest.fn().mockResolvedValue(true) } as unknown as OrgPdpService;
    const audit = { record: jest.fn().mockResolvedValue(undefined) } as unknown as OrgAuditService;
    const seats = {} as SeatsService;
    const epoch = {
      bump: jest.fn().mockResolvedValue(undefined),
    } as unknown as ProjectAccessEpochService;
    const directory = {
      revokeSessions: jest.fn().mockResolvedValue(0),
      resolve: jest.fn().mockResolvedValue(new Map()),
    } as unknown as import('../user-directory/user-directory.service').UserDirectoryService;
    const events = {
      emit: jest.fn(),
    } as unknown as import('../outbox/control-event.emitter').ControlEventEmitter;
    const org = new OrgStructureService(
      prisma,
      audit,
      seats,
      pdp,
      bindings,
      epoch,
      directory,
      events,
    );

    const res = await org.deleteDepartment(DEPT, 'admin-u');
    expect(res).toEqual({ ok: true });
    // Binding gone, department gone.
    expect(tables.bindings).toHaveLength(0);
    expect(tables.departments).toHaveLength(0);
    // Only the manual membership survives.
    expect(tables.members).toHaveLength(1);
    expect(tables.members[0].userId).toBe('u9');
    expect(tables.members[0].source).toBe('manual');
    // Touched project epoch bumped.
    expect(epoch.bump).toHaveBeenCalledWith(PROJ);
  });

  it('rejects delete when children or employees remain (strategy=forbid)', async () => {
    const { prisma } = makePrisma({
      departments: [
        { id: DEPT, organizationId: ORG, parentId: null },
        { id: 'child', organizationId: ORG, parentId: DEPT },
      ],
      employees: [
        { id: 'e1', organizationId: ORG, userId: 'u1', departmentId: DEPT, isActive: true },
      ],
    });
    const bindings = makeBindings(prisma);
    const pdp = { canManage: jest.fn().mockResolvedValue(true) } as unknown as OrgPdpService;
    const audit = { record: jest.fn().mockResolvedValue(undefined) } as unknown as OrgAuditService;
    const org = new OrgStructureService(
      prisma,
      audit,
      {} as SeatsService,
      pdp,
      bindings,
      { bump: jest.fn(), bumpOrgProjects: jest.fn() } as unknown as ProjectAccessEpochService,
      { revokeSessions: jest.fn(), resolve: jest.fn() } as never,
      { emit: jest.fn() } as never,
    );
    await expect(org.deleteDepartment(DEPT, 'admin-u')).rejects.toMatchObject({
      // 'conflict' → ALREADY_EXISTS → HTTP 409 (canon FR-ORG-190 «409 department_not_empty»).
      errorCode: 'conflict',
      details: { code: 'DEPARTMENT_NOT_EMPTY' },
    });
  });

  it('rejects an unknown delete strategy instead of silently SET-NULLing the subtree (FR-ORG-190)', async () => {
    const { prisma } = makePrisma({
      departments: [
        { id: DEPT, organizationId: ORG, parentId: null },
        { id: 'child', organizationId: ORG, parentId: DEPT },
      ],
      employees: [],
    });
    const bindings = makeBindings(prisma);
    const pdp = { canManage: jest.fn().mockResolvedValue(true) } as unknown as OrgPdpService;
    const audit = { record: jest.fn().mockResolvedValue(undefined) } as unknown as OrgAuditService;
    const org = new OrgStructureService(
      prisma,
      audit,
      {} as SeatsService,
      pdp,
      bindings,
      { bump: jest.fn(), bumpOrgProjects: jest.fn() } as unknown as ProjectAccessEpochService,
      { revokeSessions: jest.fn(), resolve: jest.fn() } as never,
      { emit: jest.fn() } as never,
    );
    await expect(org.deleteDepartment(DEPT, 'admin-u', 'cascade')).rejects.toMatchObject({
      errorCode: 'invalid',
      details: { code: 'INVALID_DELETE_STRATEGY' },
    });
  });

  it('reparents active employees to the parent department on strategy=reparent (FR-ORG-190)', async () => {
    const PARENT = 'parent-dept';
    const { prisma, tables } = makePrisma({
      departments: [
        { id: PARENT, organizationId: ORG, parentId: null },
        { id: DEPT, organizationId: ORG, parentId: PARENT },
      ],
      employees: [
        { id: 'e1', organizationId: ORG, userId: 'u1', departmentId: DEPT, isActive: true },
      ],
    });
    const bindings = makeBindings(prisma);
    const pdp = { canManage: jest.fn().mockResolvedValue(true) } as unknown as OrgPdpService;
    const audit = { record: jest.fn().mockResolvedValue(undefined) } as unknown as OrgAuditService;
    const org = new OrgStructureService(
      prisma,
      audit,
      {} as SeatsService,
      pdp,
      bindings,
      { bump: jest.fn(), bumpOrgProjects: jest.fn() } as unknown as ProjectAccessEpochService,
      { revokeSessions: jest.fn(), resolve: jest.fn() } as never,
      { emit: jest.fn() } as never,
    );

    await org.deleteDepartment(DEPT, 'admin-u', 'reparent');

    expect(tables.employees[0].departmentId).toBe(PARENT);
    expect(tables.departments.map((d) => d.id)).toEqual([PARENT]);
  });

  it('reparented employees gain the PARENT department binding memberships, like a normal transfer (FR-MORG-11)', async () => {
    const PARENT = 'parent-dept';
    const PROJ_SHARED = 'proj-shared'; // bound by BOTH the dying dept and the parent
    const PROJ_PARENT = 'proj-parent'; // bound only by the parent
    const { prisma, tables } = makePrisma({
      departments: [
        { id: PARENT, organizationId: ORG, parentId: null },
        { id: DEPT, organizationId: ORG, parentId: PARENT },
      ],
      employees: [
        { id: 'e1', organizationId: ORG, userId: 'u1', departmentId: DEPT, isActive: true },
      ],
      bindings: [
        {
          id: 'b-dying',
          organizationId: ORG,
          departmentId: DEPT,
          projectId: PROJ_SHARED,
          defaultRole: 'member',
          scope: 'self',
          status: 'active',
        },
        {
          id: 'b-parent-shared',
          organizationId: ORG,
          departmentId: PARENT,
          projectId: PROJ_SHARED,
          defaultRole: 'manager',
          scope: 'self',
          status: 'active',
        },
        {
          id: 'b-parent-only',
          organizationId: ORG,
          departmentId: PARENT,
          projectId: PROJ_PARENT,
          defaultRole: 'member',
          scope: 'self',
          status: 'active',
        },
      ],
      members: [
        // Existing materialization from the dying department's binding.
        {
          id: 'pm-dying',
          projectId: PROJ_SHARED,
          userId: 'u1',
          role: 'member',
          source: 'binding',
          bindingId: 'b-dying',
          departmentId: DEPT,
        },
      ],
    });
    const bindings = makeBindings(prisma);
    const pdp = { canManage: jest.fn().mockResolvedValue(true) } as unknown as OrgPdpService;
    const audit = { record: jest.fn().mockResolvedValue(undefined) } as unknown as OrgAuditService;
    const epoch = {
      bump: jest.fn().mockResolvedValue(undefined),
      bumpOrgProjects: jest.fn(),
    } as unknown as ProjectAccessEpochService;
    const org = new OrgStructureService(
      prisma,
      audit,
      {} as SeatsService,
      pdp,
      bindings,
      epoch,
      { revokeSessions: jest.fn(), resolve: jest.fn() } as never,
      { emit: jest.fn() } as never,
    );

    await org.deleteDepartment(DEPT, 'admin-u', 'reparent');

    // The parent-only bound project is materialized for the moved employee.
    const parentOnly = tables.members.filter((m) => m.projectId === PROJ_PARENT);
    expect(parentOnly).toHaveLength(1);
    expect(parentOnly[0]).toMatchObject({
      userId: 'u1',
      source: 'binding',
      bindingId: 'b-parent-only',
      departmentId: PARENT,
    });
    // The shared project: the dying binding's row was dematerialized FIRST, so
    // the parent's binding re-materializes it (no shadowing, no dangling row).
    const shared = tables.members.filter((m) => m.projectId === PROJ_SHARED);
    expect(shared).toHaveLength(1);
    expect(shared[0]).toMatchObject({
      userId: 'u1',
      source: 'binding',
      bindingId: 'b-parent-shared',
      role: 'manager',
    });
    expect(epoch.bump).toHaveBeenCalledWith(PROJ_SHARED);
    expect(epoch.bump).toHaveBeenCalledWith(PROJ_PARENT);
  });
});

describe('InvitationService.resend — pending uniqueness (FR-ORG-410)', () => {
  it('supersedes another pending invite for the same email before re-arming (no partial-unique violation)', async () => {
    const { prisma, tables } = makePrisma({
      invitations: [
        {
          id: 'inv-old',
          token: 'tok-old',
          organizationId: ORG,
          email: 'x@y.z',
          status: 'expired',
          role: 'employee',
          departmentId: null,
          expiresAt: new Date(Date.now() - 3_600_000),
        },
        {
          id: 'inv-new',
          token: 'tok-new',
          organizationId: ORG,
          email: 'x@y.z',
          status: 'pending',
          role: 'employee',
          departmentId: null,
          expiresAt: new Date(Date.now() + 3_600_000),
        },
      ],
    });
    const bindings = makeBindings(prisma);
    const pdp = { canManage: jest.fn().mockResolvedValue(true) } as unknown as OrgPdpService;
    const audit = { record: jest.fn().mockResolvedValue(undefined) } as unknown as OrgAuditService;
    const epoch = {
      bump: jest.fn().mockResolvedValue(undefined),
    } as unknown as ProjectAccessEpochService;
    const inv = new InvitationService(prisma, audit, pdp, bindings, epoch);

    const out = await inv.resend('inv-old', 'admin-u');

    expect(out.status).toBe('pending');
    // Exactly ONE pending row for (org, email) survives — the resent one.
    const pending = tables.invitations.filter((i) => i.email === 'x@y.z' && i.status === 'pending');
    expect(pending).toHaveLength(1);
    expect(pending[0].id).toBe('inv-old');
    expect(tables.invitations.find((i) => i.id === 'inv-new')!.status).toBe('revoked');
  });
});

describe('InvitationService.accept — binding materialization (review #2, FR-MORG-24)', () => {
  it('materializes source="binding" for a bound dept; a projectGrant on the same project wins', async () => {
    const PROJ_A = 'proj-a'; // bound only (defaultRole=manager) → materializes
    const PROJ_B = 'proj-b'; // bound AND granted → grant wins, hook skips
    const { prisma, tables } = makePrisma({
      departments: [{ id: DEPT, organizationId: ORG }],
      projects: [{ id: PROJ_B, ownerType: 'ORGANIZATION', ownerId: ORG }],
      bindings: [
        {
          id: 'ba',
          organizationId: ORG,
          departmentId: DEPT,
          projectId: PROJ_A,
          defaultRole: 'manager',
          scope: 'self',
          status: 'active',
        },
        {
          id: 'bb',
          organizationId: ORG,
          departmentId: DEPT,
          projectId: PROJ_B,
          defaultRole: 'member',
          scope: 'self',
          status: 'active',
        },
      ],
      invitations: [
        {
          id: 'inv1',
          token: 'tok',
          organizationId: ORG,
          status: 'pending',
          role: 'employee',
          departmentId: DEPT,
          expiresAt: new Date(Date.now() + 3_600_000),
          projectGrants: [{ projectId: PROJ_B, role: 'admin' }],
        },
      ],
    });
    const bindings = makeBindings(prisma);
    const pdp = {
      ensureSystemOrgRoles: jest.fn().mockResolvedValue(new Map()),
      syncEmployeeRoleAssignment: jest.fn().mockResolvedValue(undefined),
    } as unknown as OrgPdpService;
    const audit = { record: jest.fn().mockResolvedValue(undefined) } as unknown as OrgAuditService;
    const epoch = {
      bump: jest.fn().mockResolvedValue(undefined),
    } as unknown as ProjectAccessEpochService;
    const inv = new InvitationService(prisma, audit, pdp, bindings, epoch);

    const out = await inv.accept('tok', 'newu');
    expect(out.organizationId).toBe(ORG);

    // PROJ_A: binding materialized with the binding's defaultRole.
    const a = tables.members.filter((m) => m.projectId === PROJ_A);
    expect(a).toHaveLength(1);
    expect(a[0].source).toBe('binding');
    expect(a[0].role).toBe('manager');
    expect(a[0].userId).toBe('newu');

    // PROJ_B: exactly one member — the explicit grant wins, hook skipped (not doubled).
    const b = tables.members.filter((m) => m.projectId === PROJ_B);
    expect(b).toHaveLength(1);
    expect(b[0].role).toBe('admin');
    expect(b[0].source).not.toBe('binding');

    // Only PROJ_A's membership changed via the binding hook → its epoch is bumped.
    expect(epoch.bump).toHaveBeenCalledWith(PROJ_A);
    expect(epoch.bump).not.toHaveBeenCalledWith(PROJ_B);
  });

  it('re-hire takes the INVITATION role — an offboarded admin invited as employee does not resurrect admin (FR-ORG-430)', async () => {
    const { prisma, tables } = makePrisma({
      departments: [{ id: DEPT, organizationId: ORG }],
      employees: [
        {
          id: 'e-old',
          organizationId: ORG,
          userId: 'rehired',
          role: 'platform_admin',
          departmentId: null,
          isActive: false,
        },
      ],
      invitations: [
        {
          id: 'inv2',
          token: 'tok2',
          organizationId: ORG,
          status: 'pending',
          role: 'employee',
          departmentId: DEPT,
          expiresAt: new Date(Date.now() + 3_600_000),
          projectGrants: [],
        },
      ],
    });
    const bindings = makeBindings(prisma);
    const pdp = {
      ensureSystemOrgRoles: jest.fn().mockResolvedValue(new Map()),
      syncEmployeeRoleAssignment: jest.fn().mockResolvedValue(undefined),
    } as unknown as OrgPdpService;
    const audit = { record: jest.fn().mockResolvedValue(undefined) } as unknown as OrgAuditService;
    const epoch = {
      bump: jest.fn().mockResolvedValue(undefined),
    } as unknown as ProjectAccessEpochService;
    const inv = new InvitationService(prisma, audit, pdp, bindings, epoch);

    await inv.accept('tok2', 'rehired');

    const emp = tables.employees.find((e) => e.userId === 'rehired')!;
    expect(emp.isActive).toBe(true);
    expect(emp.role).toBe('employee');
    // The in-transaction assignment sync must land the INVITED role too.
    expect(pdp.syncEmployeeRoleAssignment).toHaveBeenCalledWith(
      expect.anything(),
      ORG,
      'rehired',
      'employee',
      'rehired',
    );
  });
});
