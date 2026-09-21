import { OrgStructureService } from './org-structure.service';
import { OrgAuditService } from './org-audit.service';
import { SeatsService } from './seats.service';
import { OrgPdpService } from './org-pdp.service';
import { DepartmentBindingsService } from './department-bindings.service';
import { ProjectAccessEpochService } from '../projects/project-access-epoch.service';
import { UserDirectoryService } from '../user-directory/user-directory.service';
import { ControlEventEmitter } from '../outbox/control-event.emitter';
import { PrismaService } from '../prisma/prisma.service';
import { AppError } from '@fairflow/shared';

/**
 * BX-OFFB — offboarding access-revocation cascade (security HIGH / 152-ФЗ).
 * `deactivateEmployee` / `removeEmployee` must, on top of the soft-delete:
 *  - revoke ALL project access (manual AND binding ProjectMember rows) in the
 *    org's projects, plus the user's project-scoped RoleAssignments and
 *    member-addressed PermissionGrants;
 *  - clear the org system-role assignment (existing W7 behaviour, kept);
 *  - bump the gateway permission-cache epoch for every touched project;
 *  - revoke the departed member's live auth sessions (fail-soft — never rolls
 *    back the offboard).
 * A hand-rolled Prisma fake with a real $transaction backs the real service.
 */

type Rec = Record<string, unknown>;

const matches = (row: Rec, where: Rec): boolean => {
  for (const [k, v] of Object.entries(where)) {
    if (v === undefined) continue;
    if (v !== null && typeof v === 'object' && 'in' in (v as Rec)) {
      if (!(v as { in: unknown[] }).in.includes(row[k])) return false;
      continue;
    }
    if (row[k] !== v) return false;
  }
  return true;
};

function makePrisma(seed: {
  employees: Rec[];
  projectMembers?: Rec[];
  projects?: Rec[];
  roleAssignments?: Rec[];
  permissionGrants?: Rec[];
}) {
  const tables: Record<string, Rec[]> = {
    employee: seed.employees,
    projectMember: seed.projectMembers ?? [],
    project: seed.projects ?? [],
    roleAssignment: seed.roleAssignments ?? [],
    permissionGrant: seed.permissionGrants ?? [],
  };
  const model = (name: string) => ({
    findUnique: jest.fn(({ where }: { where: Rec }) => {
      const orgKey = where.organizationId_userId as
        | { organizationId: string; userId: string }
        | undefined;
      if (orgKey) {
        return Promise.resolve(
          tables[name].find(
            (r) => r.organizationId === orgKey.organizationId && r.userId === orgKey.userId,
          ) ?? null,
        );
      }
      const projectKey = where.projectId_userId as
        | { projectId: string; userId: string }
        | undefined;
      if (projectKey) {
        return Promise.resolve(
          tables[name].find(
            (r) => r.projectId === projectKey.projectId && r.userId === projectKey.userId,
          ) ?? null,
        );
      }
      return Promise.resolve(tables[name].find((r) => matches(r, where)) ?? null);
    }),
    findMany: jest.fn(({ where }: { where?: Rec } = {}) =>
      Promise.resolve(tables[name].filter((r) => matches(r, where ?? {}))),
    ),
    update: jest.fn(({ where, data }: { where: Rec; data: Rec }) => {
      const key = where.organizationId_userId as { organizationId: string; userId: string };
      const row = tables[name].find(
        (r) => r.organizationId === key.organizationId && r.userId === key.userId,
      );
      if (row) Object.assign(row, data);
      return Promise.resolve(row ?? null);
    }),
    deleteMany: jest.fn(({ where }: { where: Rec }) => {
      const before = tables[name].length;
      tables[name] = tables[name].filter((r) => !matches(r, where));
      return Promise.resolve({ count: before - tables[name].length });
    }),
    updateMany: jest.fn(({ where, data }: { where: Rec; data: Rec }) => {
      let count = 0;
      for (const row of tables[name]) {
        if (matches(row, where)) {
          Object.assign(row, data);
          count++;
        }
      }
      return Promise.resolve({ count });
    }),
  });
  const store: Rec = {
    tables,
    employee: model('employee'),
    projectMember: model('projectMember'),
    project: model('project'),
    roleAssignment: model('roleAssignment'),
    permissionGrant: model('permissionGrant'),
    department: {
      findUnique: jest.fn(() => Promise.resolve(null)),
    },
    $transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn(store),
  };
  return store as unknown as PrismaService & { tables: Record<string, Rec[]> };
}

function makeService(prisma: PrismaService, revokeResult: number | null = 1) {
  const pdp = {
    canManage: jest.fn().mockResolvedValue(true),
    clearEmployeeSystemRoleAssignments: jest.fn().mockResolvedValue(undefined),
  } as unknown as OrgPdpService;
  const audit = { record: jest.fn().mockResolvedValue(undefined) } as unknown as OrgAuditService;
  const seats = { invalidate: jest.fn() } as unknown as SeatsService;
  const bindings = {
    bindingMembershipRemoveEmployee: jest.fn().mockResolvedValue([]),
  } as unknown as DepartmentBindingsService;
  const epoch = {
    bump: jest.fn().mockResolvedValue(undefined),
  } as unknown as ProjectAccessEpochService;
  const revokeSessions = jest.fn().mockResolvedValue(revokeResult);
  const directory = { revokeSessions } as unknown as UserDirectoryService;
  const events = { emit: jest.fn().mockResolvedValue(undefined) } as unknown as ControlEventEmitter;
  const service = new OrgStructureService(
    prisma,
    audit,
    seats,
    pdp,
    bindings,
    epoch,
    directory,
    events,
  );
  return { service, epoch, revokeSessions, audit, events };
}

const ORG = 'org-1';
const orgProject = (id: string): Rec => ({
  id,
  ownerType: 'ORGANIZATION',
  ownerId: ORG,
});

describe('OrgStructureService offboarding cascade (BX-OFFB)', () => {
  it('deactivate revokes ALL project access (manual + binding), sessions and epochs', async () => {
    const prisma = makePrisma({
      employees: [{ organizationId: ORG, userId: 'emp-u', role: 'employee', isActive: true }],
      projectMembers: [
        { userId: 'emp-u', projectId: 'p-org', source: 'manual' },
        { userId: 'emp-u', projectId: 'p-org2', source: 'binding' },
      ],
      projects: [orgProject('p-org'), orgProject('p-org2')],
      roleAssignments: [
        { projectId: 'p-org', subjectType: 'user', subjectId: 'emp-u', roleId: 'r1' },
        { projectId: 'p-org', subjectType: 'user', subjectId: 'other-u', roleId: 'r1' },
      ],
      permissionGrants: [
        { projectId: 'p-org', granteeType: 'member', granteeId: 'emp-u' },
        { projectId: 'p-org', granteeType: 'member', granteeId: 'other-u' },
      ],
    });
    const { service, epoch, revokeSessions } = makeService(prisma);

    await service.deactivateEmployee(ORG, 'emp-u', 'admin-u');

    const t = (prisma as unknown as { tables: Record<string, Rec[]> }).tables;
    // seat freed
    expect(t.employee[0].isActive).toBe(false);
    // BOTH manual and binding memberships gone
    expect(t.projectMember.filter((m) => m.userId === 'emp-u')).toHaveLength(0);
    // only the departed user's project-scoped assignments/grants removed
    expect(t.roleAssignment.map((r) => r.subjectId)).toEqual(['other-u']);
    expect(t.permissionGrant.map((g) => g.granteeId)).toEqual(['other-u']);
    // epoch bumped for every touched project
    expect((epoch.bump as jest.Mock).mock.calls.map((c) => c[0]).sort()).toEqual([
      'p-org',
      'p-org2',
    ]);
    // live sessions revoked for exactly the departed user
    expect(revokeSessions).toHaveBeenCalledWith(['emp-u']);
  });

  it('emits control.member.offboarded per revoked project with the reassign target (BX-OFFB-2)', async () => {
    const prisma = makePrisma({
      employees: [
        {
          organizationId: ORG,
          userId: 'emp-u',
          role: 'employee',
          isActive: true,
          departmentId: 'dept-1',
        },
        { organizationId: ORG, userId: 'mgr-u', role: 'employee', isActive: true },
      ],
      projectMembers: [
        { userId: 'emp-u', projectId: 'p-org', source: 'manual' },
        { userId: 'emp-u', projectId: 'p-org2', source: 'binding' },
        { userId: 'mgr-u', projectId: 'p-org', source: 'manual' },
        { userId: 'mgr-u', projectId: 'p-org2', source: 'manual' },
      ],
      projects: [orgProject('p-org'), orgProject('p-org2')],
    });
    (
      prisma as unknown as { department: { findUnique: jest.Mock } }
    ).department.findUnique.mockResolvedValue({ leaderUserId: 'lead-u' });
    const { service, events } = makeService(prisma);

    await service.deactivateEmployee(ORG, 'emp-u', 'admin-u', 'mgr-u');

    const emit = events.emit as jest.Mock;
    // one event per revoked org-project
    const offboardCalls = emit.mock.calls.filter(
      (c) => (c[1] as { routingKey?: string }).routingKey === 'control.member.offboarded',
    );
    expect(offboardCalls.map((c) => (c[1] as { projectId?: string }).projectId).sort()).toEqual([
      'p-org',
      'p-org2',
    ]);
    for (const c of offboardCalls) {
      const input = c[1] as { entityId?: string; metadata?: Record<string, unknown> };
      expect(input.entityId).toBe('emp-u');
      expect(input.metadata?.reassignToUserId).toBe('mgr-u');
      expect(input.metadata?.departingUserId).toBe('emp-u');
      expect(input.metadata?.departmentId).toBe('dept-1');
      expect(input.metadata?.departmentLeaderUserId).toBe('lead-u');
    }
  });

  it('does not emit an offboard event when there is no valid reassign target (BX-OFFB-2)', async () => {
    // actor 'admin-u' is not an active employee here → no fallback target → no emit.
    const prisma = makePrisma({
      employees: [{ organizationId: ORG, userId: 'emp-u', role: 'employee', isActive: true }],
      projectMembers: [{ userId: 'emp-u', projectId: 'p-org', source: 'manual' }],
      projects: [orgProject('p-org')],
    });
    const { service, events } = makeService(prisma);

    await service.deactivateEmployee(ORG, 'emp-u', 'admin-u');

    const emit = events.emit as jest.Mock;
    expect(
      emit.mock.calls.filter(
        (c) => (c[1] as { routingKey?: string }).routingKey === 'control.member.offboarded',
      ),
    ).toHaveLength(0);
  });

  it('remove revokes access + sessions the same way', async () => {
    const prisma = makePrisma({
      employees: [{ organizationId: ORG, userId: 'emp-u', role: 'employee', isActive: true }],
      projectMembers: [{ userId: 'emp-u', projectId: 'p-org', source: 'manual' }],
      projects: [orgProject('p-org')],
    });
    const { service, revokeSessions } = makeService(prisma);

    await service.removeEmployee(ORG, 'emp-u', 'admin-u');

    const t = (prisma as unknown as { tables: Record<string, Rec[]> }).tables;
    expect(t.projectMember).toHaveLength(0);
    expect(revokeSessions).toHaveBeenCalledWith(['emp-u']);
  });

  it('does not touch a PERSONAL project the user also belongs to', async () => {
    const prisma = makePrisma({
      employees: [{ organizationId: ORG, userId: 'emp-u', role: 'employee', isActive: true }],
      projectMembers: [
        { userId: 'emp-u', projectId: 'p-org', source: 'manual' },
        { userId: 'emp-u', projectId: 'p-personal', source: 'manual' },
      ],
      projects: [
        orgProject('p-org'),
        { id: 'p-personal', ownerType: 'PERSONAL', ownerId: 'emp-u' },
      ],
    });
    const { service } = makeService(prisma);

    await service.deactivateEmployee(ORG, 'emp-u', 'admin-u');

    const t = (prisma as unknown as { tables: Record<string, Rec[]> }).tables;
    expect(t.projectMember.map((m) => m.projectId)).toEqual(['p-personal']);
  });

  it('session-revocation failure (auth down) does NOT roll back the offboard', async () => {
    const prisma = makePrisma({
      employees: [{ organizationId: ORG, userId: 'emp-u', role: 'employee', isActive: true }],
      projects: [orgProject('p-org')],
    });
    const { service, revokeSessions } = makeService(prisma, /* revokeResult */ null);

    const emp = await service.deactivateEmployee(ORG, 'emp-u', 'admin-u');

    expect(emp).toBeTruthy();
    const t = (prisma as unknown as { tables: Record<string, Rec[]> }).tables;
    expect(t.employee[0].isActive).toBe(false);
    expect(revokeSessions).toHaveBeenCalledTimes(1);
  });

  it('refuses to offboard the platform_owner', async () => {
    const prisma = makePrisma({
      employees: [
        { organizationId: ORG, userId: 'owner-u', role: 'platform_owner', isActive: true },
      ],
    });
    const { service, revokeSessions } = makeService(prisma);

    await expect(service.deactivateEmployee(ORG, 'owner-u', 'admin-u')).rejects.toBeInstanceOf(
      AppError,
    );
    expect(revokeSessions).not.toHaveBeenCalled();
  });
});
