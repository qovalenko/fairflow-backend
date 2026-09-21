import { OrgPdpService } from './org-pdp.service';
import { OrgStructureService } from './org-structure.service';
import { OrgAuditService } from './org-audit.service';
import { SeatsService } from './seats.service';
import { RolesService } from '../roles/roles.service';
import { PrismaService } from '../prisma/prisma.service';
import { ProjectsService } from '../projects/projects.service';
import { ControlEventEmitter } from '../outbox/control-event.emitter';
import { RoleAuditService } from '../outbox/role-audit.service';
import {
  ORG_STRUCTURE_KEYS,
  expandSystemOrgRolePermissions,
  parsePermissionKey,
} from '@fairflow/shared';

/**
 * P8 T4.1 — org-structure RBAC on the PDP. These tests assert the acceptance
 * criteria:
 *  (а) default-equivalence: owner/admin pass every structure mutation, a plain
 *      employee is denied — exactly as the old binary `orgRoleCanManage` gated;
 *  (б) an HR custom role (org:employees:manage, WITHOUT org:departments:manage)
 *      may add an employee but NOT create a department;
 *  (в) a deny grant overrides an allow;
 *  (г) system org roles are immutable;
 *  (д) the fallback (no seeded roles/assignments) reproduces the old behaviour.
 *
 * A tiny in-memory Prisma fake backs the real services (no DB). It implements the
 * exact subset the services touch: employee/role/rolePermission/roleAssignment/
 * permissionGrant/roleAuditLog/orgAuditLog + $transaction + $queryRaw.
 */

interface Rec {
  [k: string]: unknown;
}

function makeFakePrisma() {
  const tables: Record<string, Rec[]> = {
    organization: [],
    employee: [],
    department: [],
    role: [],
    rolePermission: [],
    roleAssignment: [],
    permissionGrant: [],
    roleAuditLog: [],
    orgAuditLog: [],
    project: [],
    projectMember: [],
    systemSettings: [],
  };

  const matches = (row: Rec, where: Rec): boolean => {
    for (const [k, v] of Object.entries(where)) {
      if (v === undefined) continue;
      if (v !== null && typeof v === 'object' && 'in' in (v as Rec)) {
        if (!(v as { in: unknown[] }).in.includes(row[k])) return false;
        continue;
      }
      if (v !== null && typeof v === 'object' && 'not' in (v as Rec)) {
        if (row[k] === (v as { not: unknown }).not) return false;
        continue;
      }
      if (row[k] !== v) return false;
    }
    return true;
  };

  // Compound-unique lookups the services use ({ scopeType_scopeId_key },
  // { organizationId_userId }, { projectId_subjectType_subjectId_roleId_scope }).
  const flattenWhere = (where: Rec): Rec => {
    const out: Rec = {};
    for (const [k, v] of Object.entries(where)) {
      if (v && typeof v === 'object' && !('in' in v) && !('not' in v)) {
        // compound key object → flatten its members
        if (
          k === 'organizationId_userId' ||
          k === 'scopeType_scopeId_key' ||
          k === 'projectId_subjectType_subjectId_roleId_scope'
        ) {
          Object.assign(out, v as Rec);
          continue;
        }
      }
      out[k] = v;
    }
    return out;
  };

  const model = (name: string) => ({
    findUnique: async ({ where }: { where: Rec }) => {
      const w = flattenWhere(where);
      return tables[name].find((r) => matches(r, w)) ?? null;
    },
    findFirst: async ({ where, orderBy }: { where: Rec; orderBy?: Rec }) => {
      let list = tables[name].filter((r) => matches(r, where ?? {}));
      if (orderBy) list = [...list];
      return list[0] ?? null;
    },
    findMany: async ({ where }: { where?: Rec } = {}) =>
      tables[name].filter((r) => matches(r, where ?? {})),
    count: async ({ where }: { where?: Rec } = {}) =>
      tables[name].filter((r) => matches(r, where ?? {})).length,
    create: async ({ data }: { data: Rec }) => {
      const row = { ...data };
      tables[name].push(row);
      return row;
    },
    createMany: async ({ data }: { data: Rec[] }) => {
      for (const d of data) tables[name].push({ ...d });
      return { count: data.length };
    },
    update: async ({ where, data }: { where: Rec; data: Rec }) => {
      const w = flattenWhere(where);
      const row = tables[name].find((r) => matches(r, w));
      if (!row) throw new Error(`${name} not found`);
      Object.assign(row, data);
      return row;
    },
    upsert: async ({ where, create, update }: { where: Rec; create: Rec; update: Rec }) => {
      const w = flattenWhere(where);
      const row = tables[name].find((r) => matches(r, w));
      if (row) {
        Object.assign(row, update);
        return row;
      }
      const created = { ...create };
      tables[name].push(created);
      return created;
    },
    deleteMany: async ({ where }: { where: Rec }) => {
      const before = tables[name].length;
      tables[name] = tables[name].filter((r) => !matches(r, where));
      return { count: before - tables[name].length };
    },
  });

  const store: Rec = {
    tables,
    organization: model('organization'),
    employee: model('employee'),
    department: model('department'),
    role: {
      ...model('role'),
      // Attach permission rows + default timestamps (mapRole reads createdAt).
      hydrate: (r: Rec | null) =>
        r
          ? {
              isArchived: false,
              createdAt: (r.createdAt as Date) ?? new Date(),
              updatedAt: (r.updatedAt as Date) ?? new Date(),
              ...r,
              permissions: tables.rolePermission.filter((p) => p.roleId === r.id),
            }
          : null,
      findUnique: async ({ where }: { where: Rec }) => {
        const w = flattenWhere(where);
        const r = tables.role.find((x) => matches(x, w)) ?? null;
        return (store.role as { hydrate: (r: Rec | null) => Rec | null }).hydrate(r);
      },
      findFirst: async ({ where }: { where?: Rec } = {}) => {
        const r = tables.role.find((x) => matches(x, where ?? {})) ?? null;
        return (store.role as { hydrate: (r: Rec | null) => Rec | null }).hydrate(r);
      },
      // role.findMany with include: { permissions: true }
      findMany: async ({ where }: { where?: Rec } = {}) =>
        tables.role
          .filter((r) => matches(r, where ?? {}))
          .map((r) => (store.role as { hydrate: (r: Rec | null) => Rec | null }).hydrate(r)!),
      create: async ({ data }: { data: Rec }) => {
        const row = { isArchived: false, createdAt: new Date(), updatedAt: new Date(), ...data };
        tables.role.push(row);
        return row;
      },
    },
    rolePermission: model('rolePermission'),
    roleAssignment: {
      ...model('roleAssignment'),
      upsert: async ({ where, create, update }: { where: Rec; create: Rec; update: Rec }) => {
        const w = flattenWhere(where);
        const row = tables.roleAssignment.find((r) => matches(r, w));
        if (row) {
          Object.assign(row, update);
          return row;
        }
        const created = { createdAt: new Date(), ...create };
        tables.roleAssignment.push(created);
        return created;
      },
      findMany: async ({ where }: { where?: Rec } = {}) =>
        tables.roleAssignment
          .filter((r) => matches(r, where ?? {}))
          .map((r) => {
            const role = tables.role.find((x) => x.id === r.roleId);
            return {
              ...r,
              role: role
                ? {
                    ...role,
                    permissions: tables.rolePermission.filter((p) => p.roleId === role.id),
                  }
                : undefined,
            };
          }),
    },
    permissionGrant: model('permissionGrant'),
    project: model('project'),
    projectMember: model('projectMember'),
    systemSettings: model('systemSettings'),
    roleAuditLog: {
      ...model('roleAuditLog'),
      findFirst: async ({ where }: { where: Rec }) => {
        const w = { ...where };
        delete (w as Rec).chainHash;
        const list = tables.roleAuditLog.filter(
          (r) => matches(r, w) && (where.chainHash ? r.chainHash != null : true),
        );
        return list[list.length - 1] ?? null;
      },
    },
    orgAuditLog: {
      ...model('orgAuditLog'),
      findFirst: async ({ where }: { where: Rec }) => {
        const w = { ...where };
        delete (w as Rec).chainHash;
        const list = tables.orgAuditLog.filter(
          (r) => matches(r, w) && (where.chainHash ? r.chainHash != null : true),
        );
        return list[list.length - 1] ?? null;
      },
    },
    $queryRaw: async () => [{ pg_advisory_xact_lock: '' }],
    $executeRaw: async () => 1, // advisory lock via $executeRaw (void return)
    $transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn(store),
  };
  return store;
}

function seedOrg(prisma: Rec, orgId: string, members: { userId: string; role: string }[]) {
  (prisma.tables as Record<string, Rec[]>).organization.push({ id: orgId, name: orgId });
  (prisma.tables as Record<string, Rec[]>).systemSettings.push({
    id: orgId,
    name: orgId,
    isActive: true,
  });
  for (const m of members) {
    (prisma.tables as Record<string, Rec[]>).employee.push({
      id: `emp-${m.userId}`,
      organizationId: orgId,
      userId: m.userId,
      role: m.role,
      isActive: true,
      departmentId: null,
    });
  }
}

describe('OrgPdpService.resolveOrgEffective', () => {
  let prisma: ReturnType<typeof makeFakePrisma>;
  let pdp: OrgPdpService;

  beforeEach(() => {
    prisma = makeFakePrisma();
    pdp = new OrgPdpService(prisma as unknown as PrismaService);
    seedOrg(prisma, 'org-1', [
      { userId: 'owner-u', role: 'platform_owner' },
      { userId: 'admin-u', role: 'platform_admin' },
      { userId: 'emp-u', role: 'employee' },
    ]);
  });

  it('(д) fallback: owner/admin carry the full vocabulary, employee read-only (no seed)', async () => {
    const owner = await pdp.resolveOrgEffective('org-1', 'owner-u');
    expect(owner.allow.sort()).toEqual([...ORG_STRUCTURE_KEYS].sort());
    const admin = await pdp.resolveOrgEffective('org-1', 'admin-u');
    expect(admin.allow.sort()).toEqual([...ORG_STRUCTURE_KEYS].sort());
    const emp = await pdp.resolveOrgEffective('org-1', 'emp-u');
    expect(emp.allow.sort()).toEqual([...expandSystemOrgRolePermissions('employee')].sort());
    // employee holds NO manage key.
    expect(emp.allow.some((k) => k.endsWith(':manage'))).toBe(false);
  });

  it('(а) default-equivalence: canManage matches old orgRoleCanManage per subject', async () => {
    for (const subj of [
      'org:employees',
      'org:departments',
      'org:units',
      'org:invitations',
      'org:profile',
    ]) {
      expect(await pdp.canManage('org-1', 'owner-u', subj)).toBe(true);
      expect(await pdp.canManage('org-1', 'admin-u', subj)).toBe(true);
      expect(await pdp.canManage('org-1', 'emp-u', subj)).toBe(false);
    }
    // a non-member is denied everything.
    expect(await pdp.canManage('org-1', 'ghost', 'org:employees')).toBe(false);
  });

  it('FR-ORG-600: department leader gets org:audit:read; a plain employee does not', async () => {
    (prisma.tables as Record<string, Rec[]>).employee.push({
      id: 'emp-plain',
      organizationId: 'org-1',
      userId: 'plain-u',
      role: 'employee',
      isActive: true,
      departmentId: 'dept-led',
    });
    (prisma.tables as Record<string, Rec[]>).department.push({
      id: 'dept-led',
      organizationId: 'org-1',
      name: 'Sales',
      leaderUserId: 'emp-u',
    });
    const leader = await pdp.resolveOrgEffective('org-1', 'emp-u');
    expect(leader.allow).toContain('org:audit:read');
    const plain = await pdp.resolveOrgEffective('org-1', 'plain-u');
    expect(plain.allow).not.toContain('org:audit:read');
  });

  it('FR-ORG-490: a deactivated member resolves to an EMPTY set (fail-closed)', async () => {
    // A fired platform_admin: the Employee row stays (audit/reactivation) but
    // isActive=false — the Layer-1 floor must NOT be folded in.
    (prisma.tables as Record<string, Rec[]>).employee.push({
      id: 'emp-fired',
      organizationId: 'org-1',
      userId: 'fired-admin',
      role: 'platform_admin',
      isActive: false,
      departmentId: null,
    });
    const eff = await pdp.resolveOrgEffective('org-1', 'fired-admin');
    expect(eff).toEqual({ allow: [], deny: [], orgRole: '', isMember: false });
    expect(await pdp.canManage('org-1', 'fired-admin', 'org:departments')).toBe(false);
    expect(await pdp.can('org-1', 'fired-admin', 'org:employees', 'read')).toBe(false);
  });

  it('(в) a deny grant overrides the role allow', async () => {
    await pdp.ensureSystemOrgRoles('org-1');
    (prisma.tables as Record<string, Rec[]>).permissionGrant.push({
      id: 'g1',
      projectId: 'org-1',
      moduleId: 'organization',
      effect: 'deny',
      subject: 'org:employees',
      action: 'manage',
      resource: '*',
      granteeType: 'member',
      granteeId: 'owner-u',
      createdBy: 'x',
    });
    // owner keeps everything except the denied key.
    expect(await pdp.canManage('org-1', 'owner-u', 'org:employees')).toBe(false);
    expect(await pdp.canManage('org-1', 'owner-u', 'org:departments')).toBe(true);
  });

  it('ensureSystemOrgRoles is idempotent and seeds the three immutable roles', async () => {
    await pdp.ensureSystemOrgRoles('org-1');
    await pdp.ensureSystemOrgRoles('org-1');
    const roles = (prisma.tables as Record<string, Rec[]>).role.filter(
      (r) => r.scopeType === 'organization' && r.scopeId === 'org-1',
    );
    expect(roles).toHaveLength(3);
    expect(roles.every((r) => r.kind === 'system')).toBe(true);
    const owner = roles.find((r) => r.key === 'platform_owner')!;
    const perms = (prisma.tables as Record<string, Rec[]>).rolePermission.filter(
      (p) => p.roleId === owner.id,
    );
    expect(perms).toHaveLength(ORG_STRUCTURE_KEYS.length);
  });
});

describe('Org services gate on the PDP (P8 T4.1)', () => {
  let prisma: ReturnType<typeof makeFakePrisma>;
  let pdp: OrgPdpService;
  let structure: OrgStructureService;
  let roles: RolesService;

  const seats = {
    assertSeatAvailable: async () => undefined,
    invalidate: () => undefined,
  } as unknown as SeatsService;

  beforeEach(() => {
    prisma = makeFakePrisma();
    pdp = new OrgPdpService(prisma as unknown as PrismaService);
    const noopEmitter = { emit: async () => undefined } as unknown as ControlEventEmitter;
    const audit = new OrgAuditService(
      prisma as unknown as PrismaService,
      noopEmitter,
      { can: async () => true } as unknown as OrgPdpService,
      { resolveLedDepartmentSubtree: async () => [] } as unknown as OrgStructureService,
    );
    const bindingsStub = {
      bindingMembershipAddEmployee: async () => [],
      bindingMembershipRemoveEmployee: async () => [],
    } as unknown as import('./department-bindings.service').DepartmentBindingsService;
    const epochStub = {
      bump: async () => undefined,
      bumpOrgProjects: async () => undefined,
    } as unknown as import('../projects/project-access-epoch.service').ProjectAccessEpochService;
    const directoryStub = {
      revokeSessions: async () => 0,
      resolve: async (ids: string[]) => {
        const map = new Map<string, { id: string; name: string; email: string; login: string }>();
        for (const id of ids) {
          if (id) map.set(id, { id, name: id, email: `${id}@test`, login: id });
        }
        return map;
      },
    } as unknown as import('../user-directory/user-directory.service').UserDirectoryService;
    structure = new OrgStructureService(
      prisma as unknown as PrismaService,
      audit,
      seats,
      pdp,
      bindingsStub,
      epochStub,
      directoryStub,
      noopEmitter,
    );
    roles = new RolesService(
      prisma as unknown as PrismaService,
      {} as ProjectsService,
      pdp,
      new RoleAuditService(noopEmitter),
    );
    seedOrg(prisma, 'org-1', [
      { userId: 'owner-u', role: 'platform_owner' },
      { userId: 'emp-u', role: 'employee' },
      { userId: 'hr-u', role: 'employee' },
    ]);
  });

  it('(а) owner adds an employee; a plain employee is denied (access error)', async () => {
    await expect(
      structure.addEmployee('org-1', 'new-u', 'employee', undefined, 'owner-u'),
    ).resolves.toBeDefined();
    await expect(
      structure.addEmployee('org-1', 'new-u2', 'employee', undefined, 'emp-u'),
    ).rejects.toMatchObject({ errorCode: 'access' });
  });

  it('(а) owner creates a department; a plain employee is denied', async () => {
    await expect(
      structure.createDepartment('org-1', 'Sales', undefined, 'owner-u'),
    ).resolves.toBeDefined();
    await expect(
      structure.createDepartment('org-1', 'Ops', undefined, 'emp-u'),
    ).rejects.toMatchObject({
      errorCode: 'access',
    });
  });

  it('(б) HR role: org:employees:manage grants add-employee but NOT create-department', async () => {
    // owner creates the HR role and assigns it to hr-u.
    const hrRole = await roles.createOrgRole({
      organizationId: 'org-1',
      actorUserId: 'owner-u',
      name: 'HR',
      permissions: ['org:employees:read', 'org:employees:manage'],
    });
    await roles.grantOrgRole({
      organizationId: 'org-1',
      actorUserId: 'owner-u',
      userId: 'hr-u',
      roleId: hrRole.id,
    });

    // HR can add an employee…
    await expect(
      structure.addEmployee('org-1', 'hired-u', 'employee', undefined, 'hr-u'),
    ).resolves.toBeDefined();
    // …but cannot create a department (no org:departments:manage).
    await expect(
      structure.createDepartment('org-1', 'HR-dept', undefined, 'hr-u'),
    ).rejects.toMatchObject({ errorCode: 'access' });
  });

  it('(г) system org roles are immutable (update/delete rejected)', async () => {
    await pdp.ensureSystemOrgRoles('org-1');
    const sysOwner = (prisma.tables as Record<string, Rec[]>).role.find(
      (r) => r.scopeType === 'organization' && r.key === 'platform_owner',
    )!;
    await expect(
      roles.updateOrgRole({
        organizationId: 'org-1',
        actorUserId: 'owner-u',
        roleId: sysOwner.id as string,
        name: 'hacked',
      }),
    ).rejects.toMatchObject({ details: { code: 'SYSTEM_ROLE_IMMUTABLE' } });
    await expect(
      roles.deleteOrgRole({
        organizationId: 'org-1',
        actorUserId: 'owner-u',
        roleId: sysOwner.id as string,
      }),
    ).rejects.toMatchObject({ details: { code: 'SYSTEM_ROLE_IMMUTABLE' } });
  });

  it('no-self-escalation on org scope: a non-owner cannot grant a key they lack', async () => {
    // Give hr-u an org:employees:manage role first (so they are not the owner).
    const hrRole = await roles.createOrgRole({
      organizationId: 'org-1',
      actorUserId: 'owner-u',
      name: 'HR',
      permissions: ['org:employees:manage'],
    });
    await roles.grantOrgRole({
      organizationId: 'org-1',
      actorUserId: 'owner-u',
      userId: 'hr-u',
      roleId: hrRole.id,
    });
    // hr-u (not owner) tries to mint a role with org:departments:manage they don't hold.
    await expect(
      roles.createOrgRole({
        organizationId: 'org-1',
        actorUserId: 'hr-u',
        name: 'Escalated',
        permissions: ['org:departments:manage'],
      }),
    ).rejects.toMatchObject({ details: { code: 'SELF_ESCALATION_DENIED' } });
  });

  it('org role validation rejects a non-vocabulary key', async () => {
    await expect(
      roles.createOrgRole({
        organizationId: 'org-1',
        actorUserId: 'owner-u',
        name: 'Bad',
        permissions: ['deals:manage'],
      }),
    ).rejects.toMatchObject({ details: { code: 'ROLE_PERMISSION_NOT_IN_CATALOG' } });
  });

  it('vocabulary sanity: every key parses and OrgPdpService defaults are safe', () => {
    for (const key of ORG_STRUCTURE_KEYS) {
      expect(parsePermissionKey(key)).not.toBeNull();
    }
    expect(() => OrgPdpService.assertDefaultsSafe()).not.toThrow();
  });
});

/**
 * P8 W7 — provisioning system org-role assignments on live data + keeping the
 * assignment layer in lock-step with `Employee.role`. Acceptance: the resolved
 * union is byte-for-byte identical before/after provisioning (default preserved),
 * the HR delegation still works on top, and add/update/offboard/reactivate keep
 * the dual-source consistent.
 */
describe('OrgPdpService.provisionOrgRoles (W7)', () => {
  let prisma: ReturnType<typeof makeFakePrisma>;
  let pdp: OrgPdpService;
  let structure: OrgStructureService;
  let roles: RolesService;

  const seats = {
    assertSeatAvailable: async () => undefined,
    invalidate: () => undefined,
  } as unknown as SeatsService;

  const sysAssignments = (userId: string) =>
    (prisma.tables as Record<string, Rec[]>).roleAssignment.filter(
      (a) => a.projectId === 'org-1' && a.scope === 'organization' && a.subjectId === userId,
    );
  const sysRoleKeyOf = (roleId: unknown) =>
    (prisma.tables as Record<string, Rec[]>).role.find((r) => r.id === roleId)?.key;

  beforeEach(() => {
    prisma = makeFakePrisma();
    pdp = new OrgPdpService(prisma as unknown as PrismaService);
    const noopEmitter = { emit: async () => undefined } as unknown as ControlEventEmitter;
    const audit = new OrgAuditService(
      prisma as unknown as PrismaService,
      noopEmitter,
      { can: async () => true } as unknown as OrgPdpService,
      { resolveLedDepartmentSubtree: async () => [] } as unknown as OrgStructureService,
    );
    const bindingsStub = {
      bindingMembershipAddEmployee: async () => [],
      bindingMembershipRemoveEmployee: async () => [],
    } as unknown as import('./department-bindings.service').DepartmentBindingsService;
    const epochStub = {
      bump: async () => undefined,
      bumpOrgProjects: async () => undefined,
    } as unknown as import('../projects/project-access-epoch.service').ProjectAccessEpochService;
    const directoryStub = {
      revokeSessions: async () => 0,
      resolve: async (ids: string[]) => {
        const map = new Map<string, { id: string; name: string; email: string; login: string }>();
        for (const id of ids) {
          if (id) map.set(id, { id, name: id, email: `${id}@test`, login: id });
        }
        return map;
      },
    } as unknown as import('../user-directory/user-directory.service').UserDirectoryService;
    structure = new OrgStructureService(
      prisma as unknown as PrismaService,
      audit,
      seats,
      pdp,
      bindingsStub,
      epochStub,
      directoryStub,
      noopEmitter,
    );
    roles = new RolesService(
      prisma as unknown as PrismaService,
      {} as ProjectsService,
      pdp,
      new RoleAuditService(noopEmitter),
    );
    seedOrg(prisma, 'org-1', [
      { userId: 'owner-u', role: 'platform_owner' },
      { userId: 'admin-u', role: 'platform_admin' },
      { userId: 'emp-u', role: 'employee' },
    ]);
    // An offboarded member must NOT be backfilled.
    (prisma.tables as Record<string, Rec[]>).employee.push({
      id: 'emp-gone',
      organizationId: 'org-1',
      userId: 'gone-u',
      role: 'employee',
      isActive: false,
      departmentId: null,
    });
  });

  it('backfills exactly one system-role assignment per ACTIVE employee (idempotent)', async () => {
    await pdp.provisionOrgRoles('org-1');
    await pdp.provisionOrgRoles('org-1'); // second run must not duplicate
    expect(sysAssignments('owner-u').map((a) => sysRoleKeyOf(a.roleId))).toEqual([
      'platform_owner',
    ]);
    expect(sysAssignments('admin-u').map((a) => sysRoleKeyOf(a.roleId))).toEqual([
      'platform_admin',
    ]);
    expect(sysAssignments('emp-u').map((a) => sysRoleKeyOf(a.roleId))).toEqual(['employee']);
    // Inactive member is skipped.
    expect(sysAssignments('gone-u')).toHaveLength(0);
  });

  it('resolve is byte-for-byte identical before vs after provisioning (default preserved)', async () => {
    const before = {
      owner: (await pdp.resolveOrgEffective('org-1', 'owner-u')).allow,
      admin: (await pdp.resolveOrgEffective('org-1', 'admin-u')).allow,
      emp: (await pdp.resolveOrgEffective('org-1', 'emp-u')).allow,
    };
    await pdp.provisionOrgRoles('org-1');
    const after = {
      owner: (await pdp.resolveOrgEffective('org-1', 'owner-u')).allow,
      admin: (await pdp.resolveOrgEffective('org-1', 'admin-u')).allow,
      emp: (await pdp.resolveOrgEffective('org-1', 'emp-u')).allow,
    };
    expect(after).toEqual(before);
    expect(after.owner.sort()).toEqual([...ORG_STRUCTURE_KEYS].sort());
    expect(after.emp.sort()).toEqual([...expandSystemOrgRolePermissions('employee')].sort());
    expect(after.emp.some((k) => k.endsWith(':manage'))).toBe(false);
  });

  it('HR delegation works on top of provisioned roles; owner/admin/employee unchanged', async () => {
    await pdp.provisionOrgRoles('org-1');
    const hr = await roles.createOrgRole({
      organizationId: 'org-1',
      actorUserId: 'owner-u',
      name: 'HR',
      permissions: ['org:employees:read', 'org:employees:manage'],
    });
    await roles.grantOrgRole({
      organizationId: 'org-1',
      actorUserId: 'owner-u',
      userId: 'emp-u',
      roleId: hr.id,
    });
    // employee + HR → manage employees, NOT manage departments.
    expect(await pdp.canManage('org-1', 'emp-u', 'org:employees')).toBe(true);
    expect(await pdp.canManage('org-1', 'emp-u', 'org:departments')).toBe(false);
    // A second plain employee stays read-only; owner/admin stay full.
    expect(await pdp.canManage('org-1', 'owner-u', 'org:departments')).toBe(true);
    expect(await pdp.canManage('org-1', 'admin-u', 'org:departments')).toBe(true);
    // no-self-escalation still holds: emp-u (holds employees:manage only) cannot
    // mint a role carrying departments:manage.
    await expect(
      roles.createOrgRole({
        organizationId: 'org-1',
        actorUserId: 'emp-u',
        name: 'Escalated',
        permissions: ['org:departments:manage'],
      }),
    ).rejects.toMatchObject({ details: { code: 'SELF_ESCALATION_DENIED' } });
  });

  it('updateEmployee re-points the system-role assignment (floor ↔ assignment stay in sync)', async () => {
    await structure.updateEmployee('org-1', 'emp-u', { role: 'platform_admin' }, 'owner-u');
    // Exactly one system assignment, now platform_admin (old employee one dropped).
    expect(sysAssignments('emp-u').map((a) => sysRoleKeyOf(a.roleId))).toEqual(['platform_admin']);
    // And the resolve reflects the promotion (full vocabulary).
    const eff = await pdp.resolveOrgEffective('org-1', 'emp-u');
    expect(eff.allow.sort()).toEqual([...ORG_STRUCTURE_KEYS].sort());
  });

  it('offboard drops the system-role assignment; reactivate re-instates it', async () => {
    await pdp.provisionOrgRoles('org-1');
    expect(sysAssignments('emp-u')).toHaveLength(1);
    await structure.deactivateEmployee('org-1', 'emp-u', 'owner-u');
    expect(sysAssignments('emp-u')).toHaveLength(0);
    await structure.reactivateEmployee('org-1', 'emp-u', 'owner-u');
    expect(sysAssignments('emp-u').map((a) => sysRoleKeyOf(a.roleId))).toEqual(['employee']);
  });

  it('FR-ORG-490: a deactivated platform_admin loses ALL org access; reactivation restores it', async () => {
    expect(await pdp.canManage('org-1', 'admin-u', 'org:departments')).toBe(true);
    await structure.deactivateEmployee('org-1', 'admin-u', 'owner-u');
    // PDP: empty allow-set, role not reported, not a member (fail-closed).
    const eff = await pdp.resolveOrgEffective('org-1', 'admin-u');
    expect(eff).toEqual({ allow: [], deny: [], orgRole: '', isMember: false });
    expect(await pdp.canManage('org-1', 'admin-u', 'org:departments')).toBe(false);
    // Gates: manage-gated mutation AND plain member-gated read both deny.
    await expect(
      structure.createDepartment('org-1', 'Backdoor', undefined, 'admin-u'),
    ).rejects.toMatchObject({ errorCode: 'access' });
    await expect(structure.listEmployees('org-1', 'admin-u')).rejects.toMatchObject({
      errorCode: 'access',
    });
    // Reactivation (by the owner) restores the admin's access.
    await structure.reactivateEmployee('org-1', 'admin-u', 'owner-u');
    expect(await pdp.canManage('org-1', 'admin-u', 'org:departments')).toBe(true);
    await expect(structure.listEmployees('org-1', 'admin-u')).resolves.toBeDefined();
  });

  it('addEmployee lands the new member’s system-role assignment atomically', async () => {
    await structure.addEmployee('org-1', 'hired-u', 'platform_admin', undefined, 'owner-u');
    expect(sysAssignments('hired-u').map((a) => sysRoleKeyOf(a.roleId))).toEqual([
      'platform_admin',
    ]);
  });
});
