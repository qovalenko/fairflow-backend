import { DepartmentBindingsService } from './department-bindings.service';
import { OrgAuditService } from './org-audit.service';
import { OrgPdpService } from './org-pdp.service';
import { ProjectAccessEpochService } from '../projects/project-access-epoch.service';
import { PrismaService } from '../prisma/prisma.service';
import { AppError } from '@fairflow/shared';

/**
 * FR-MORG-7/8/9/10/11 — department→project bindings + atomic ProjectMember
 * materialization. These tests pin the invariants that make a binding safe:
 *  - create materializes a ProjectMember(source='binding', role, bindingId,
 *    departmentId) for every ACTIVE employee of the department, in the SAME
 *    transaction (FR-MORG-25/20);
 *  - a pre-existing membership (source='manual' OR another binding) is NEVER
 *    overwritten (FR-MORG-3);
 *  - a duplicate (department, project) binding is rejected (BINDING_EXISTS) —
 *    the @@unique guard (FR-MORG-7);
 *  - delete dematerializes only this binding's source='binding' rows, manual
 *    memberships survive (FR-MORG-8);
 *  - scope='subtree' is rejected in v1 (FR-MORG-9).
 *
 * A minimal hand-rolled Prisma fake backs the real service (no DB) — $transaction
 * runs the callback against the same in-memory store so tx-atomic writes are
 * observable.
 */

type Rec = Record<string, unknown>;

function makePrisma(seed: {
  departments?: Rec[];
  projects?: Rec[];
  bindings?: Rec[];
  members?: Rec[];
  employees?: Rec[];
}) {
  const departments = seed.departments ?? [];
  const projects = seed.projects ?? [];
  const bindings = seed.bindings ?? [];
  const members = seed.members ?? [];
  const employees = seed.employees ?? [];

  const store = {
    department: {
      findUnique: ({ where }: { where: Rec }) =>
        Promise.resolve(departments.find((d) => d.id === where.id) ?? null),
    },
    project: {
      findUnique: ({ where }: { where: Rec }) =>
        Promise.resolve(projects.find((p) => p.id === where.id) ?? null),
      findMany: ({ where }: { where: Rec }) => {
        const ids = (where.id as { in: string[] }).in;
        return Promise.resolve(projects.filter((p) => ids.includes(p.id as string)));
      },
    },
    role: {
      findFirst: () => Promise.resolve(null),
    },
    departmentProjectBinding: {
      findUnique: ({ where }: { where: Rec }) => {
        // Return a COPY (real Prisma returns fresh objects) so a later tx update
        // that mutates the stored row does not retroactively change this snapshot.
        const found = where.id
          ? bindings.find((b) => b.id === where.id)
          : (() => {
              const key = where.departmentId_projectId as {
                departmentId: string;
                projectId: string;
              };
              return bindings.find(
                (b) => b.departmentId === key.departmentId && b.projectId === key.projectId,
              );
            })();
        return Promise.resolve(found ? { ...found } : null);
      },
      findMany: ({ where }: { where: Rec }) =>
        Promise.resolve(
          bindings.filter(
            (b) =>
              (where.organizationId === undefined || b.organizationId === where.organizationId) &&
              (where.departmentId === undefined || b.departmentId === where.departmentId) &&
              (where.status === undefined || b.status === where.status) &&
              (where.scope === undefined || b.scope === where.scope),
          ),
        ),
      create: ({ data }: { data: Rec }) => {
        const row = { createdAt: new Date(), updatedAt: new Date(), ...data };
        bindings.push(row);
        return Promise.resolve(row);
      },
      update: ({ where, data }: { where: Rec; data: Rec }) => {
        const row = bindings.find((b) => b.id === where.id)!;
        Object.assign(row, data);
        return Promise.resolve(row);
      },
      delete: ({ where }: { where: Rec }) => {
        const i = bindings.findIndex((b) => b.id === where.id);
        const [row] = bindings.splice(i, 1);
        return Promise.resolve(row);
      },
    },
    employee: {
      findMany: ({ where }: { where: Rec }) =>
        Promise.resolve(
          employees.filter(
            (e) => e.departmentId === where.departmentId && e.isActive === where.isActive,
          ),
        ),
    },
    projectMember: {
      findUnique: ({ where }: { where: Rec }) => {
        const key = where.projectId_userId as { projectId: string; userId: string };
        return Promise.resolve(
          members.find((m) => m.projectId === key.projectId && m.userId === key.userId) ?? null,
        );
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
      updateMany: ({ where, data }: { where: Rec; data: Rec }) => {
        let count = 0;
        for (const m of members) {
          if (
            (where.bindingId === undefined || m.bindingId === where.bindingId) &&
            (where.source === undefined || m.source === where.source)
          ) {
            Object.assign(m, data);
            count++;
          }
        }
        return Promise.resolve({ count });
      },
    },
    $transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn(store),
  };
  return { prisma: store as unknown as PrismaService, tables: { bindings, members } };
}

function makeService(prisma: PrismaService, canManage = true) {
  const pdp = {
    can: jest.fn().mockResolvedValue(true),
    canManage: jest.fn().mockResolvedValue(canManage),
  } as unknown as OrgPdpService;
  const audit = { record: jest.fn().mockResolvedValue(undefined) } as unknown as OrgAuditService;
  const epoch = {
    bump: jest.fn().mockResolvedValue(undefined),
  } as unknown as ProjectAccessEpochService;
  return new DepartmentBindingsService(prisma, audit, pdp, epoch);
}

const ORG = 'org-1';
const DEPT = 'dept-1';
const PROJ = 'proj-1';

describe('DepartmentBindingsService (FR-MORG-7/8/9/10/11)', () => {
  const baseSeed = () => ({
    departments: [{ id: DEPT, organizationId: ORG }],
    projects: [{ id: PROJ, name: 'Alpha', ownerType: 'ORGANIZATION', ownerId: ORG }],
    employees: [
      { userId: 'u1', departmentId: DEPT, isActive: true },
      { userId: 'u2', departmentId: DEPT, isActive: true },
      { userId: 'u3', departmentId: DEPT, isActive: false }, // inactive → skipped
    ],
  });

  it('create materializes a binding-member for each ACTIVE employee, atomically', async () => {
    const { prisma, tables } = makePrisma(baseSeed());
    const svc = makeService(prisma);
    const res = await svc.create(ORG, DEPT, { projectId: PROJ, defaultRole: 'member' }, 'admin-u');
    expect(res.projectId).toBe(PROJ);
    expect(res.defaultRole).toBe('member');
    // 2 active employees → 2 binding members; inactive u3 skipped.
    const bm = tables.members.filter((m) => m.source === 'binding');
    expect(bm).toHaveLength(2);
    expect(bm.map((m) => m.userId).sort()).toEqual(['u1', 'u2']);
    for (const m of bm) {
      expect(m.role).toBe('member');
      expect(m.departmentId).toBe(DEPT);
      expect(m.bindingId).toBe(res.id);
    }
  });

  it('create never overwrites a pre-existing (manual) membership', async () => {
    const seed = baseSeed();
    const seedWithManual = {
      ...seed,
      members: [
        { id: 'pm-manual', projectId: PROJ, userId: 'u1', role: 'admin', source: 'manual' },
      ],
    };
    const { prisma, tables } = makePrisma(seedWithManual);
    const svc = makeService(prisma);
    await svc.create(ORG, DEPT, { projectId: PROJ, defaultRole: 'member' }, 'admin-u');
    // u1 keeps its manual admin role untouched; only u2 materialized.
    const u1 = tables.members.find((m) => m.userId === 'u1')!;
    expect(u1.source).toBe('manual');
    expect(u1.role).toBe('admin');
    const bm = tables.members.filter((m) => m.source === 'binding');
    expect(bm.map((m) => m.userId)).toEqual(['u2']);
  });

  it('rejects a duplicate (department, project) binding (BINDING_EXISTS)', async () => {
    const seed = baseSeed();
    const seedWithBinding = {
      ...seed,
      bindings: [
        {
          id: 'b-existing',
          organizationId: ORG,
          departmentId: DEPT,
          projectId: PROJ,
          defaultRole: 'member',
          scope: 'self',
          status: 'active',
          createdBy: 'x',
        },
      ],
    };
    const { prisma } = makePrisma(seedWithBinding);
    const svc = makeService(prisma);
    await expect(
      svc.create(ORG, DEPT, { projectId: PROJ, defaultRole: 'member' }, 'admin-u'),
    ).rejects.toMatchObject({ details: { code: 'BINDING_EXISTS' } });
  });

  it('rejects scope="subtree" in v1 (SCOPE_SUBTREE_NOT_SUPPORTED)', async () => {
    const { prisma } = makePrisma(baseSeed());
    const svc = makeService(prisma);
    await expect(
      svc.create(
        ORG,
        DEPT,
        { projectId: PROJ, defaultRole: 'member', scope: 'subtree' },
        'admin-u',
      ),
    ).rejects.toMatchObject({ details: { code: 'SCOPE_SUBTREE_NOT_SUPPORTED' } });
  });

  it('delete dematerializes only source="binding" members; manual survive', async () => {
    const seed = baseSeed();
    const seedFull = {
      ...seed,
      bindings: [
        {
          id: 'b1',
          organizationId: ORG,
          departmentId: DEPT,
          projectId: PROJ,
          defaultRole: 'member',
          scope: 'self',
          status: 'active',
          createdBy: 'x',
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
    };
    const { prisma, tables } = makePrisma(seedFull);
    const svc = makeService(prisma);
    const res = await svc.remove(ORG, DEPT, 'b1', 'admin-u');
    expect(res).toEqual({ ok: true });
    expect(tables.bindings).toHaveLength(0);
    // Only the manual membership remains.
    expect(tables.members).toHaveLength(1);
    expect(tables.members[0].userId).toBe('u9');
    expect(tables.members[0].source).toBe('manual');
  });

  it("update role on active binding re-rolls only this binding's members", async () => {
    const seed = baseSeed();
    const seedFull = {
      ...seed,
      bindings: [
        {
          id: 'b1',
          organizationId: ORG,
          departmentId: DEPT,
          projectId: PROJ,
          defaultRole: 'member',
          scope: 'self',
          status: 'active',
          createdBy: 'x',
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
        { id: 'pm-manual', projectId: PROJ, userId: 'u9', role: 'viewer', source: 'manual' },
      ],
    };
    const { prisma, tables } = makePrisma(seedFull);
    const svc = makeService(prisma);
    await svc.update(ORG, DEPT, 'b1', { defaultRole: 'manager' }, 'admin-u');
    expect(tables.members.find((m) => m.userId === 'u1')!.role).toBe('manager');
    // manual membership untouched.
    expect(tables.members.find((m) => m.userId === 'u9')!.role).toBe('viewer');
  });

  it('manage gate: a caller without org:bindings:manage is rejected', async () => {
    const { prisma } = makePrisma(baseSeed());
    const svc = makeService(prisma, false);
    await expect(
      svc.create(ORG, DEPT, { projectId: PROJ, defaultRole: 'member' }, 'emp-u'),
    ).rejects.toBeInstanceOf(AppError);
  });
});
