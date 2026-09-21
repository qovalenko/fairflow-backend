import { AccessUnitService } from './access-unit.service';
import { OrgAuditService } from './org-audit.service';
import { OrgPdpService } from './org-pdp.service';
import { OrgStructureService } from './org-structure.service';
import { PrismaService } from '../prisma/prisma.service';
import { AppError } from '@fairflow/shared';
import { ControlEventEmitter } from '../outbox/control-event.emitter';

const noopEmitter = { emit: async () => undefined } as unknown as ControlEventEmitter;

/**
 * BX-MODEL-8 §7.2 — composition-preview. `previewComposition` returns the
 * EFFECTIVE user count of a unit's composition (BFS-expanded down group edges,
 * mirroring the visibility-resolver's `addEffectiveUsers`), optionally with a
 * candidate nested-group edge applied — so the UI can show "состав вырастет N→M"
 * BEFORE persisting. Pure read: never mutates the graph.
 *
 * A small in-memory Prisma fake backs the real service (no DB).
 */

interface Rec {
  [k: string]: unknown;
}

function makeFakePrisma() {
  const tables: Record<string, Rec[]> = {
    projectMember: [],
    accessUnit: [],
    accessUnitMember: [],
    orgAuditLog: [],
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
        if (k === 'projectId_userId' || k === 'organizationId_userId') {
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
    findFirst: async ({ where }: { where?: Rec } = {}) =>
      tables[name].filter((r) => matches(r, where ?? {}))[0] ?? null,
    findMany: async ({ where }: { where?: Rec } = {}) =>
      tables[name].filter((r) => matches(r, where ?? {})),
  });

  const store: Rec = {
    tables,
    projectMember: model('projectMember'),
    accessUnit: model('accessUnit'),
    accessUnitMember: model('accessUnitMember'),
    orgAuditLog: model('orgAuditLog'),
    $transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn(store),
  };
  return store;
}

const PROJECT = 'proj-1';

function makeService(prisma: Rec): AccessUnitService {
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
  return new AccessUnitService(prisma as unknown as PrismaService, audit, pdp);
}

function seedManager(prisma: Rec, userId: string) {
  (prisma.tables as Record<string, Rec[]>).projectMember.push({
    id: `pm-${userId}`,
    projectId: PROJECT,
    userId,
    role: 'manager',
  });
}

function seedUnit(prisma: Rec, id: string, scopeId = PROJECT, archived = false) {
  (prisma.tables as Record<string, Rec[]>).accessUnit.push({
    id,
    scopeType: 'PROJECT',
    scopeId,
    name: id,
    kind: 'custom',
    parentId: null,
    leaderUserId: null,
    archivedAt: archived ? new Date() : null,
  });
}

function seedMember(prisma: Rec, unitId: string, memberType: 'user' | 'group', memberId: string) {
  (prisma.tables as Record<string, Rec[]>).accessUnitMember.push({
    id: `m-${unitId}-${memberType}-${memberId}`,
    unitId,
    memberType,
    memberId,
    addedBy: 'seed',
  });
}

describe('AccessUnitService.previewComposition (BX-MODEL-8 §7.2)', () => {
  let prisma: ReturnType<typeof makeFakePrisma>;
  let svc: AccessUnitService;
  const MGR = 'mgr-u';

  beforeEach(() => {
    prisma = makeFakePrisma();
    svc = makeService(prisma);
    seedManager(prisma, MGR);
  });

  it('linear A ⊃ (add) B ⊃ {u1,u2}: current 0 → projected 2, added 2', async () => {
    seedUnit(prisma, 'A');
    seedUnit(prisma, 'B');
    seedMember(prisma, 'B', 'user', 'u1');
    seedMember(prisma, 'B', 'user', 'u2');

    const res = await svc.previewComposition({ unitId: 'A', addGroupId: 'B', actorUserId: MGR });
    expect(res).toEqual({
      currentUserCount: 0,
      projectedUserCount: 2,
      addedUserCount: 2,
      crossScopeDropped: 0,
    });
  });

  it('transitive A ⊃ (add) B ⊃ C ⊃ {u3}: chain expands to 1 user', async () => {
    seedUnit(prisma, 'A');
    seedUnit(prisma, 'B');
    seedUnit(prisma, 'C');
    seedMember(prisma, 'B', 'group', 'C');
    seedMember(prisma, 'C', 'user', 'u3');

    const res = await svc.previewComposition({ unitId: 'A', addGroupId: 'B', actorUserId: MGR });
    expect(res.currentUserCount).toBe(0);
    expect(res.projectedUserCount).toBe(1);
    expect(res.addedUserCount).toBe(1);
    expect(res.crossScopeDropped).toBe(0);
  });

  it('re-adding an already-nested group yields added 0 (idempotent preview)', async () => {
    seedUnit(prisma, 'A');
    seedUnit(prisma, 'B');
    seedMember(prisma, 'A', 'group', 'B'); // A already contains B
    seedMember(prisma, 'B', 'user', 'u1');
    seedMember(prisma, 'B', 'user', 'u2');

    // current reflects the existing composition (2 effective users).
    const res = await svc.previewComposition({ unitId: 'A', addGroupId: 'B', actorUserId: MGR });
    expect(res.currentUserCount).toBe(2);
    expect(res.projectedUserCount).toBe(2);
    expect(res.addedUserCount).toBe(0);
    expect(res.crossScopeDropped).toBe(0);
  });

  it('dedups overlapping members: A has u1 directly, add B{u1,u2} → added only u2', async () => {
    seedUnit(prisma, 'A');
    seedUnit(prisma, 'B');
    seedMember(prisma, 'A', 'user', 'u1');
    seedMember(prisma, 'B', 'user', 'u1');
    seedMember(prisma, 'B', 'user', 'u2');

    const res = await svc.previewComposition({ unitId: 'A', addGroupId: 'B', actorUserId: MGR });
    expect(res.currentUserCount).toBe(1);
    expect(res.projectedUserCount).toBe(2);
    expect(res.addedUserCount).toBe(1);
    expect(res.crossScopeDropped).toBe(0);
  });

  it('no addGroupId → projected == current, added 0', async () => {
    seedUnit(prisma, 'A');
    seedMember(prisma, 'A', 'user', 'u1');

    const res = await svc.previewComposition({ unitId: 'A', actorUserId: MGR });
    expect(res).toEqual({
      currentUserCount: 1,
      projectedUserCount: 1,
      addedUserCount: 0,
      crossScopeDropped: 0,
    });
  });

  it('cross-scope candidate: cannot be nested → added 0, its members counted as dropped', async () => {
    seedUnit(prisma, 'A'); // proj-1
    seedUnit(prisma, 'X', 'proj-2'); // different scope
    seedMember(prisma, 'X', 'user', 'ux1');
    seedMember(prisma, 'X', 'user', 'ux2');

    const res = await svc.previewComposition({ unitId: 'A', addGroupId: 'X', actorUserId: MGR });
    expect(res.currentUserCount).toBe(0);
    expect(res.projectedUserCount).toBe(0);
    expect(res.addedUserCount).toBe(0);
    expect(res.crossScopeDropped).toBe(2);
  });

  it('missing candidate group is a notFound error', async () => {
    seedUnit(prisma, 'A');
    await expect(
      svc.previewComposition({ unitId: 'A', addGroupId: 'ghost', actorUserId: MGR }),
    ).rejects.toBeInstanceOf(AppError);
  });

  it('authz: a non-manager is denied (access)', async () => {
    seedUnit(prisma, 'A');
    await expect(
      svc.previewComposition({ unitId: 'A', addGroupId: undefined, actorUserId: 'stranger' }),
    ).rejects.toMatchObject({ errorCode: 'access' });
  });
});
