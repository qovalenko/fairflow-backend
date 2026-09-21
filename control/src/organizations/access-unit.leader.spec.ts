import { AccessUnitService } from './access-unit.service';
import { OrgAuditService } from './org-audit.service';
import { OrgPdpService } from './org-pdp.service';
import { OrgStructureService } from './org-structure.service';
import { PrismaService } from '../prisma/prisma.service';
import { AppError } from '@fairflow/shared';
import { ControlEventEmitter } from '../outbox/control-event.emitter';

// No-op outbox emitter: this spec verifies delegation, not the bus path.
const noopEmitter = { emit: async () => undefined } as unknown as ControlEventEmitter;

/**
 * P8-T4.2 — unit-leader delegation. A unit leader (`AccessUnit.leaderUserId`,
 * unit not archived) may manage the COMPOSITION of their OWN subtree — the led
 * unit plus every transitive `parentId` descendant — without holding the org-wide
 * `org:units:manage`. These tests pin the boundary:
 *
 *  - leader manages their unit + sub-unit (addMember/removeMember/update/
 *    create-child);
 *  - leader CANNOT touch a foreign unit, reparent OUT of / a foreign unit INTO the
 *    subtree, archive, or add an employee to the ORGANIZATION (org membership,
 *    not unit composition);
 *  - a plain employee (non-leader) is denied exactly as before;
 *  - owner/admin pass through the T4.1 PDP path unchanged;
 *  - an ARCHIVED led unit grants nothing (severs the branch).
 *
 * A small in-memory Prisma fake backs the real services (no DB), implementing the
 * subset AccessUnitService + OrgAuditService + OrgPdpService touch.
 */

interface Rec {
  [k: string]: unknown;
}

function makeFakePrisma() {
  const tables: Record<string, Rec[]> = {
    organization: [],
    employee: [],
    projectMember: [],
    accessUnit: [],
    accessUnitMember: [],
    role: [],
    rolePermission: [],
    roleAssignment: [],
    permissionGrant: [],
    orgAuditLog: [],
    systemSettings: [],
    department: [],
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

  const flattenWhere = (where: Rec): Rec => {
    const out: Rec = {};
    for (const [k, v] of Object.entries(where)) {
      if (v && typeof v === 'object' && !('in' in v) && !('not' in v)) {
        if (
          k === 'organizationId_userId' ||
          k === 'projectId_userId' ||
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
    findUniqueOrThrow: async ({ where }: { where: Rec }) => {
      const w = flattenWhere(where);
      const row = tables[name].find((r) => matches(r, w));
      if (!row) throw new Error(`${name} not found`);
      return row;
    },
    findFirst: async ({ where }: { where?: Rec } = {}) =>
      tables[name].filter((r) => matches(r, where ?? {}))[0] ?? null,
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
    projectMember: model('projectMember'),
    accessUnit: model('accessUnit'),
    accessUnitMember: model('accessUnitMember'),
    role: {
      ...model('role'),
      findUnique: async ({ where }: { where: Rec }) => {
        const w = flattenWhere(where);
        const r = tables.role.find((x) => matches(x, w)) ?? null;
        return r
          ? { ...r, permissions: tables.rolePermission.filter((p) => p.roleId === r.id) }
          : null;
      },
      create: async ({ data }: { data: Rec }) => {
        const row = { createdAt: new Date(), updatedAt: new Date(), ...data };
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
    department: model('department'),
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
    systemSettings: model('systemSettings'),
    $queryRaw: async () => [{ pg_advisory_xact_lock: '' }],
    $executeRaw: async () => 1, // advisory lock via $executeRaw (void return)
    $transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn(store),
  };
  return store;
}

const ORG = 'org-1';

function seedEmployee(prisma: Rec, userId: string, role: string) {
  (prisma.tables as Record<string, Rec[]>).employee.push({
    id: `emp-${userId}`,
    organizationId: ORG,
    userId,
    role,
    isActive: true,
  });
}

/** Seed an org-scope AccessUnit; returns its id. */
function seedUnit(
  prisma: Rec,
  id: string,
  opts: { parentId?: string | null; leaderUserId?: string | null; archived?: boolean } = {},
) {
  (prisma.tables as Record<string, Rec[]>).accessUnit.push({
    id,
    scopeType: 'ORGANIZATION',
    scopeId: ORG,
    name: id,
    kind: 'custom',
    parentId: opts.parentId ?? null,
    leaderUserId: opts.leaderUserId ?? null,
    archivedAt: opts.archived ? new Date() : null,
  });
  return id;
}

describe('AccessUnitService — unit-leader delegation (P8-T4.2)', () => {
  let prisma: ReturnType<typeof makeFakePrisma>;
  let svc: AccessUnitService;

  const LEADER = 'leader-u';
  const OTHER = 'other-u';
  const TARGET = 'target-u';

  beforeEach(() => {
    prisma = makeFakePrisma();
    (prisma.tables as Record<string, Rec[]>).organization.push({ id: ORG, name: ORG });
    (prisma.tables as Record<string, Rec[]>).systemSettings.push({
      id: ORG,
      name: ORG,
      isActive: true,
    });
    const audit = new OrgAuditService(
      prisma as unknown as PrismaService,
      noopEmitter,
      {
        can: async () => true,
      } as unknown as import('./org-pdp.service').OrgPdpService,
      {
        resolveLedDepartmentSubtree: jest.fn(),
      } as unknown as OrgStructureService,
    );
    const pdp = new OrgPdpService(prisma as unknown as PrismaService);
    svc = new AccessUnitService(prisma as unknown as PrismaService, audit, pdp);

    seedEmployee(prisma, 'owner-u', 'platform_owner');
    seedEmployee(prisma, LEADER, 'employee');
    seedEmployee(prisma, OTHER, 'employee');
    seedEmployee(prisma, TARGET, 'employee');

    // Structure:  U (leader=LEADER)  →  child SUB  ;  FOREIGN (no leader, sibling)
    seedUnit(prisma, 'U', { leaderUserId: LEADER });
    seedUnit(prisma, 'SUB', { parentId: 'U', leaderUserId: null });
    seedUnit(prisma, 'FOREIGN', { leaderUserId: null });
  });

  const units = () => (prisma.tables as Record<string, Rec[]>).accessUnit;
  const members = () => (prisma.tables as Record<string, Rec[]>).accessUnitMember;

  // ─── Leader may manage their subtree ───────────────────────────────────────

  it('leader adds/removes a member on their OWN unit', async () => {
    await expect(svc.addMember('U', 'user', TARGET, LEADER)).resolves.toBeDefined();
    expect(members().some((m) => m.unitId === 'U' && m.memberId === TARGET)).toBe(true);
    await expect(svc.removeMember('U', 'user', TARGET, LEADER)).resolves.toMatchObject({
      ok: true,
    });
    expect(members().some((m) => m.unitId === 'U' && m.memberId === TARGET)).toBe(false);
  });

  it('leader adds a member on a transitive SUB-unit', async () => {
    await expect(svc.addMember('SUB', 'user', TARGET, LEADER)).resolves.toBeDefined();
    expect(members().some((m) => m.unitId === 'SUB' && m.memberId === TARGET)).toBe(true);
  });

  it('leader renames (update) a unit inside their subtree', async () => {
    await expect(svc.updateUnit('SUB', { name: 'Renamed' }, LEADER)).resolves.toMatchObject({
      name: 'Renamed',
    });
  });

  it('leader creates a child unit INSIDE their subtree (parentId in subtree)', async () => {
    const created = await svc.createUnit(
      { scopeType: 'ORGANIZATION', scopeId: ORG, name: 'NewChild', parentId: 'U' },
      LEADER,
    );
    expect(created.parentId).toBe('U');
    expect(units().some((u) => u.id === created.id)).toBe(true);
  });

  it('leader reparents WITHIN the subtree (both ends inside)', async () => {
    // add a second child of U, then move SUB under it — both inside U's subtree.
    seedUnit(prisma, 'SUB2', { parentId: 'U' });
    await expect(svc.setUnitParent('SUB', 'SUB2', LEADER)).resolves.toMatchObject({
      parentId: 'SUB2',
    });
  });

  // ─── Leader is blocked outside the subtree ─────────────────────────────────

  it('leader CANNOT manage a foreign unit (member add denied)', async () => {
    await expect(svc.addMember('FOREIGN', 'user', TARGET, LEADER)).rejects.toBeInstanceOf(AppError);
    await expect(svc.addMember('FOREIGN', 'user', TARGET, LEADER)).rejects.toMatchObject({
      errorCode: 'access',
    });
  });

  it('leader CANNOT reparent a unit OUT of the subtree (new parent foreign)', async () => {
    await expect(svc.setUnitParent('SUB', 'FOREIGN', LEADER)).rejects.toMatchObject({
      errorCode: 'access',
    });
  });

  it('leader CANNOT pull a FOREIGN unit INTO the subtree', async () => {
    await expect(svc.setUnitParent('FOREIGN', 'U', LEADER)).rejects.toMatchObject({
      errorCode: 'access',
    });
  });

  it('leader CANNOT detach their own unit to top-level (parentId=null not delegated)', async () => {
    await expect(svc.setUnitParent('SUB', null, LEADER)).rejects.toMatchObject({
      errorCode: 'access',
    });
  });

  it('leader CANNOT create a TOP-LEVEL unit (no parentId ⇒ org-wide op)', async () => {
    await expect(
      svc.createUnit({ scopeType: 'ORGANIZATION', scopeId: ORG, name: 'TopLevel' }, LEADER),
    ).rejects.toMatchObject({ errorCode: 'access' });
  });

  it('leader CANNOT create a child under a FOREIGN parent', async () => {
    await expect(
      svc.createUnit(
        { scopeType: 'ORGANIZATION', scopeId: ORG, name: 'X', parentId: 'FOREIGN' },
        LEADER,
      ),
    ).rejects.toMatchObject({ errorCode: 'access' });
  });

  it('leader CANNOT archive their own root unit (archive is owner/admin only)', async () => {
    await expect(svc.archiveUnit('U', true, LEADER)).rejects.toMatchObject({ errorCode: 'access' });
  });

  it('leader CANNOT reassign leadership via update (leaderUserId change needs full right)', async () => {
    await expect(svc.updateUnit('SUB', { leaderUserId: OTHER }, LEADER)).rejects.toMatchObject({
      errorCode: 'access',
    });
  });

  // ─── Archived led unit grants nothing ──────────────────────────────────────

  it('an ARCHIVED led unit confers no delegation (branch severed)', async () => {
    // archive the leader's root; leader should lose reach over U and SUB.
    const u = units().find((x) => x.id === 'U')!;
    u.archivedAt = new Date();
    await expect(svc.addMember('U', 'user', TARGET, LEADER)).rejects.toMatchObject({
      errorCode: 'access',
    });
    await expect(svc.addMember('SUB', 'user', TARGET, LEADER)).rejects.toMatchObject({
      errorCode: 'access',
    });
  });

  // ─── Non-leader / owner behaviour is unchanged ─────────────────────────────

  it('a plain (non-leader) employee is denied everywhere, as before', async () => {
    await expect(svc.addMember('U', 'user', TARGET, OTHER)).rejects.toMatchObject({
      errorCode: 'access',
    });
    await expect(svc.updateUnit('SUB', { name: 'x' }, OTHER)).rejects.toMatchObject({
      errorCode: 'access',
    });
  });

  it('owner passes through the T4.1 PDP path unchanged (manage everything)', async () => {
    await expect(svc.addMember('FOREIGN', 'user', TARGET, 'owner-u')).resolves.toBeDefined();
    await expect(svc.setUnitParent('SUB', null, 'owner-u')).resolves.toMatchObject({
      parentId: null,
    });
    await expect(svc.archiveUnit('U', true, 'owner-u')).resolves.toBeDefined();
    await expect(
      svc.createUnit(
        { scopeType: 'ORGANIZATION', scopeId: ORG, name: 'Top', parentId: null },
        'owner-u',
      ),
    ).resolves.toBeDefined();
  });

  it('leader delegation does NOT let a leader add an employee to the ORGANIZATION', async () => {
    // Guard: OrgStructureService.addEmployee gates on org:employees:manage via the
    // PDP with NO leader fallback — delegation lives only in AccessUnitService, so
    // the leader has no path to org-level employee mutations. Assert the PDP denies
    // the leader the org employees manage right (the exact gate addEmployee uses).
    const pdp = new OrgPdpService(prisma as unknown as PrismaService);
    expect(await pdp.canManage(ORG, LEADER, 'org:employees')).toBe(false);
    expect(await pdp.canManage(ORG, LEADER, 'org:units')).toBe(false);
  });
});
