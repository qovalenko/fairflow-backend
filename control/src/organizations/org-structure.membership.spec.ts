import { OrgStructureService } from './org-structure.service';
import { OrgAuditService } from './org-audit.service';
import { SeatsService } from './seats.service';
import { OrgPdpService } from './org-pdp.service';
import { PrismaService } from '../prisma/prisma.service';
import { AppError } from '@fairflow/shared';

/**
 * P8-T6.2 — self-membership snapshot (`getMyMembership`) + offboard dry-run
 * (`previewOffboard`). Both are read-only control-side helpers backing the FE
 * SCR-MORG-MY-MEMBERSHIP / SCR-MORG-EMPLOYEE-OFFBOARD screens. These tests pin:
 *  - getMyMembership: self-scoped, non-membership → benign empty snapshot
 *    (isMember=false), department name/leader resolved, only ORG-owned non-archived
 *    projects the caller is a member of are returned;
 *  - previewOffboard: manage-gated (org:employees), owner guard, org-owned lost
 *    projects, partial=true (record counts NOT computed here — Mongo domains).
 *
 * A minimal hand-rolled Prisma fake backs the real service (no DB) — only the
 * queries these two methods issue are implemented.
 */

type Rec = Record<string, unknown>;

function makePrisma(seed: {
  employees?: Rec[];
  departments?: Rec[];
  projectMembers?: Rec[];
  projects?: Rec[];
}) {
  const employees = seed.employees ?? [];
  const departments = seed.departments ?? [];
  const projectMembers = seed.projectMembers ?? [];
  const projects = seed.projects ?? [];
  return {
    employee: {
      findUnique: jest.fn(({ where }: { where: Rec }) => {
        const key = where.organizationId_userId as
          | { organizationId: string; userId: string }
          | undefined;
        if (!key) return Promise.resolve(null);
        return Promise.resolve(
          employees.find(
            (e) => e.organizationId === key.organizationId && e.userId === key.userId,
          ) ?? null,
        );
      }),
    },
    department: {
      findUnique: jest.fn(({ where }: { where: Rec }) =>
        Promise.resolve(departments.find((d) => d.id === where.id) ?? null),
      ),
    },
    projectMember: {
      findMany: jest.fn(({ where }: { where: Rec }) =>
        Promise.resolve(projectMembers.filter((m) => m.userId === where.userId)),
      ),
    },
    project: {
      findMany: jest.fn(({ where }: { where: Rec }) => {
        const ids = (where.id as { in: string[] }).in;
        return Promise.resolve(
          projects.filter(
            (p) =>
              ids.includes(p.id as string) &&
              p.isArchived === where.isArchived &&
              p.ownerId === where.ownerId,
          ),
        );
      }),
    },
  } as unknown as PrismaService;
}

function makeService(prisma: PrismaService, canManage = true) {
  const pdp = { canManage: jest.fn().mockResolvedValue(canManage) } as unknown as OrgPdpService;
  const audit = {} as OrgAuditService;
  const seats = {} as SeatsService;
  const bindings = {
    bindingMembershipAddEmployee: jest.fn().mockResolvedValue([]),
    bindingMembershipRemoveEmployee: jest.fn().mockResolvedValue([]),
  } as unknown as import('./department-bindings.service').DepartmentBindingsService;
  const epoch = {
    bump: jest.fn().mockResolvedValue(undefined),
    bumpOrgProjects: jest.fn().mockResolvedValue(undefined),
  } as unknown as import('../projects/project-access-epoch.service').ProjectAccessEpochService;
  const directory = {
    revokeSessions: jest.fn().mockResolvedValue(0),
  } as unknown as import('../user-directory/user-directory.service').UserDirectoryService;
  const events = {
    emit: jest.fn(),
  } as unknown as import('../outbox/control-event.emitter').ControlEventEmitter;
  return new OrgStructureService(prisma, audit, seats, pdp, bindings, epoch, directory, events);
}

const ORG = 'org-1';

describe('OrgStructureService.getMyMembership', () => {
  it('rejects an unauthenticated caller (empty actor)', async () => {
    const svc = makeService(makePrisma({}));
    await expect(svc.getMyMembership(ORG, '')).rejects.toBeInstanceOf(AppError);
  });

  it('non-member → benign empty snapshot (isMember=false), no throw', async () => {
    const svc = makeService(makePrisma({ employees: [] }));
    const m = await svc.getMyMembership(ORG, 'ghost');
    expect(m.isMember).toBe(false);
    expect(m.role).toBe('');
    expect(m.projects).toEqual([]);
  });

  it('member: role/department/leader + only org-owned non-archived projects', async () => {
    const prisma = makePrisma({
      employees: [
        { organizationId: ORG, userId: 'u1', role: 'employee', isActive: true, departmentId: 'd1' },
      ],
      departments: [{ id: 'd1', name: 'Sales', leaderUserId: 'lead-1' }],
      projectMembers: [
        { userId: 'u1', projectId: 'p-org' },
        { userId: 'u1', projectId: 'p-personal' },
        { userId: 'u1', projectId: 'p-archived' },
      ],
      projects: [
        {
          id: 'p-org',
          name: 'Org Project',
          isArchived: false,
          ownerType: 'ORGANIZATION',
          ownerId: ORG,
        },
        {
          id: 'p-personal',
          name: 'Personal',
          isArchived: false,
          ownerType: 'PERSONAL',
          ownerId: 'u1',
        },
        {
          id: 'p-archived',
          name: 'Old',
          isArchived: true,
          ownerType: 'ORGANIZATION',
          ownerId: ORG,
        },
      ],
    });
    const svc = makeService(prisma);
    const m = await svc.getMyMembership(ORG, 'u1');
    expect(m.isMember).toBe(true);
    expect(m.role).toBe('employee');
    expect(m.isActive).toBe(true);
    expect(m.departmentName).toBe('Sales');
    expect(m.leaderUserId).toBe('lead-1');
    // Personal + archived org project are excluded — only the active org project remains.
    expect(m.projects).toEqual([{ projectId: 'p-org', projectName: 'Org Project' }]);
  });

  it('member without department → empty department/leader', async () => {
    const svc = makeService(
      makePrisma({
        employees: [
          {
            organizationId: ORG,
            userId: 'u2',
            role: 'platform_admin',
            isActive: true,
            departmentId: null,
          },
        ],
      }),
    );
    const m = await svc.getMyMembership(ORG, 'u2');
    expect(m.departmentId).toBe('');
    expect(m.departmentName).toBe('');
    expect(m.leaderUserId).toBe('');
  });
});

describe('OrgStructureService.previewOffboard', () => {
  it('denies a caller lacking org:employees manage (fail-closed)', async () => {
    const svc = makeService(makePrisma({ employees: [] }), /* canManage */ false);
    await expect(svc.previewOffboard(ORG, 'target', 'nonmanager')).rejects.toBeInstanceOf(AppError);
  });

  it('unknown employee → notFound', async () => {
    const svc = makeService(makePrisma({ employees: [] }));
    await expect(svc.previewOffboard(ORG, 'ghost', 'admin')).rejects.toBeInstanceOf(AppError);
  });

  it('owner → isOwner=true (cannot be offboarded); lost projects are org-owned only', async () => {
    const prisma = makePrisma({
      employees: [{ organizationId: ORG, userId: 'owner-u', role: 'platform_owner' }],
      projectMembers: [{ userId: 'owner-u', projectId: 'p-org' }],
      projects: [
        { id: 'p-org', name: 'Org P', isArchived: false, ownerType: 'ORGANIZATION', ownerId: ORG },
      ],
    });
    const svc = makeService(prisma);
    const r = await svc.previewOffboard(ORG, 'owner-u', 'admin');
    expect(r.isOwner).toBe(true);
    expect(r.projects).toEqual([{ projectId: 'p-org', projectName: 'Org P' }]);
    // Record reassignment is out of scope for this control-only preview.
    expect(r.partial).toBe(true);
  });

  it('regular employee → isOwner=false', async () => {
    const svc = makeService(
      makePrisma({
        employees: [{ organizationId: ORG, userId: 'emp-u', role: 'employee' }],
      }),
    );
    const r = await svc.previewOffboard(ORG, 'emp-u', 'admin');
    expect(r.isOwner).toBe(false);
    expect(r.projects).toEqual([]);
  });
});
