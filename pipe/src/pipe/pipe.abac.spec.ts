/**
 * ABAC push-down (P2.d / E2-08): the pipe (deals) domain must apply the
 * gateway-resolved ABAC predicate (`x-access-predicate`) on its read paths
 * (listDeals/getDeal/kanban/dashboard) — by the product/search reference.
 * Three-state semantics (shared/grpc/inbound-metadata):
 *   absent    → no ABAC narrowing (projectId + visibility only);
 *   malformed → fail-closed DENY (broken deny-rule must never widen access);
 *   present   → AND the compiled `.mongo` fragment / gate single records via `.ir`.
 */
import { ObjectId } from 'mongodb';
import { status } from '@grpc/grpc-js';
import {
  compileMongoRaw,
  normalizeAbac,
  type AbacNode,
  type AccessPredicate,
  type VisibilityScope,
} from '@fairflow/shared';
import { PipeService } from './pipe.service';

const ALL_SCOPE: VisibilityScope = {
  mode: 'all',
  level: 'all',
  selfId: 'user-1',
  ownerIds: [],
  sharedRecordIds: [],
};

// ── minimal, faithful Mongo filter matcher (product.abac.spec parity) ──────────
function getField(doc: Record<string, unknown>, field: string): unknown {
  const v = doc[field];
  return v === undefined ? null : v;
}
function matchOps(value: unknown, ops: Record<string, unknown>): boolean {
  for (const [op, operand] of Object.entries(ops)) {
    switch (op) {
      case '$eq':
        if (!(value === operand)) return false;
        break;
      case '$ne':
        if (!(value !== operand)) return false;
        break;
      case '$in':
        if (!(Array.isArray(operand) && operand.includes(value as never))) return false;
        break;
      case '$nin':
        if (Array.isArray(operand) && operand.includes(value as never)) return false;
        break;
      case '$gt':
        if (!(typeof value === typeof operand && (value as number) > (operand as number)))
          return false;
        break;
      case '$gte':
        if (!(typeof value === typeof operand && (value as number) >= (operand as number)))
          return false;
        break;
      case '$lt':
        if (!(typeof value === typeof operand && (value as number) < (operand as number)))
          return false;
        break;
      case '$lte':
        if (!(typeof value === typeof operand && (value as number) <= (operand as number)))
          return false;
        break;
      case '$exists':
        if ((value !== null && value !== undefined) !== Boolean(operand)) return false;
        break;
      default:
        throw new Error(`unsupported op in test matcher: ${op}`);
    }
  }
  return true;
}
function matchFilter(doc: Record<string, unknown>, filter: Record<string, unknown>): boolean {
  for (const [key, cond] of Object.entries(filter)) {
    if (key === '$and') {
      if (!(cond as Record<string, unknown>[]).every((f) => matchFilter(doc, f))) return false;
      continue;
    }
    if (key === '$or') {
      if (!(cond as Record<string, unknown>[]).some((f) => matchFilter(doc, f))) return false;
      continue;
    }
    if (key === '$nor') {
      if ((cond as Record<string, unknown>[]).some((f) => matchFilter(doc, f))) return false;
      continue;
    }
    const value = getField(doc, key);
    if (cond instanceof RegExp) {
      if (!(typeof value === 'string' && cond.test(value))) return false;
      continue;
    }
    if (cond && typeof cond === 'object' && !Array.isArray(cond)) {
      const keys = Object.keys(cond as Record<string, unknown>);
      if (keys.length && keys.every((k) => k.startsWith('$'))) {
        if (!matchOps(value, cond as Record<string, unknown>)) return false;
        continue;
      }
    }
    if (cond && typeof cond === 'object' && 'toString' in (cond as object)) {
      if (String(value) !== String(cond)) return false;
      continue;
    }
    if (value !== cond) return false;
  }
  return true;
}

class FakeCollection {
  constructor(private docs: Record<string, unknown>[]) {}
  private sel(filter: Record<string, unknown>) {
    return this.docs.filter((d) => matchFilter(d, filter));
  }
  find(filter: Record<string, unknown> = {}) {
    let rows = this.sel(filter);
    const cursor = {
      sort: () => cursor,
      skip: (n: number) => ((rows = rows.slice(n)), cursor),
      limit: (n: number) => ((rows = rows.slice(0, n)), cursor),
      toArray: async () => rows,
    };
    return cursor;
  }
  async findOne(filter: Record<string, unknown> = {}) {
    return this.sel(filter)[0] ?? null;
  }
  async countDocuments(filter: Record<string, unknown> = {}) {
    return this.sel(filter).length;
  }
}

function buildService(deals: Record<string, unknown>[]): PipeService {
  const dealsColl = new FakeCollection(deals);
  const pipelinesColl = new FakeCollection([]);
  const mongo = {
    deals: () => dealsColl,
    pipelines: () => pipelinesColl,
  } as unknown as Record<string, unknown>;
  const outbox = {
    withOutbox: async (fn: (s: unknown) => Promise<{ result: unknown }>) =>
      (await fn(undefined)).result,
  };
  return new PipeService(
    mongo as never,
    outbox as never,
    { assertAssigneeMember: async () => undefined } as never,
  );
}

// `record.source == "web"` compiled as the gateway would serialize it.
const SOURCE_EQ: AbacNode = { op: 'eq', left: { ref: 'record.source' }, right: { lit: 'web' } };
function present(ir: AbacNode): AccessPredicate {
  const normalized = normalizeAbac(ir);
  return { present: true, mongo: compileMongoRaw(normalized), ir: normalized as AbacNode };
}
const ABSENT: AccessPredicate = { present: false };
const MALFORMED: AccessPredicate = { present: true, malformed: true };

const PID = 'proj-1';
const ID_A = new ObjectId('aaaaaaaaaaaaaaaaaaaaaaaa'); // source web  → passes
const ID_B = new ObjectId('bbbbbbbbbbbbbbbbbbbbbbbb'); // source cold → fails
function seed() {
  const now = Date.now();
  const base = {
    pipelineId: 'pl-1',
    stageId: 'st1',
    assigneeId: 'user-1',
    deletedAt: null,
    createdAt: now,
    updatedAt: now,
  };
  return [
    { _id: ID_A, projectId: PID, name: 'Alpha', source: 'web', ...base },
    { _id: ID_B, projectId: PID, name: 'Bravo', source: 'cold', ...base },
    {
      _id: new ObjectId('cccccccccccccccccccccccc'),
      projectId: 'other',
      name: 'X',
      source: 'web',
      ...base,
    },
  ];
}

describe('pipe ABAC predicate push-down (P2.d)', () => {
  it('listDeals: present predicate (source == web) keeps only matching rows', async () => {
    const svc = buildService(seed());
    const res = await svc.listDeals(
      PID,
      0,
      25,
      undefined,
      undefined,
      undefined,
      ALL_SCOPE,
      undefined,
      present(SOURCE_EQ),
    );
    expect(res.list.map((r) => r.id)).toEqual([ID_A.toString()]);
    expect(res.total).toBe(1);
  });

  it('listDeals: absent predicate does not change the result', async () => {
    const svc = buildService(seed());
    const withAbsent = await svc.listDeals(
      PID,
      0,
      25,
      undefined,
      undefined,
      undefined,
      ALL_SCOPE,
      undefined,
      ABSENT,
    );
    const without = await svc.listDeals(PID, 0, 25, undefined, undefined, undefined, ALL_SCOPE);
    expect(withAbsent.list.map((r) => r.id).sort()).toEqual(
      [ID_A.toString(), ID_B.toString()].sort(),
    );
    expect(withAbsent).toEqual(without);
  });

  it('listDeals: malformed predicate is fail-closed (empty)', async () => {
    const svc = buildService(seed());
    const res = await svc.listDeals(
      PID,
      0,
      25,
      undefined,
      undefined,
      undefined,
      ALL_SCOPE,
      undefined,
      MALFORMED,
    );
    expect(res.list).toEqual([]);
    expect(res.total).toBe(0);
  });

  it('getDeal: record failing the predicate is NOT_FOUND, passing returned', async () => {
    const svc = buildService(seed());
    await expect(
      svc.getDeal(PID, ID_B.toString(), ALL_SCOPE, false, present(SOURCE_EQ)),
    ).rejects.toMatchObject({
      error: { code: status.NOT_FOUND },
    });
    const ok = await svc.getDeal(PID, ID_A.toString(), ALL_SCOPE, false, present(SOURCE_EQ));
    expect(ok.id).toBe(ID_A.toString());
  });

  it('getDeal: malformed predicate is fail-closed (NOT_FOUND even for existing row)', async () => {
    const svc = buildService(seed());
    await expect(
      svc.getDeal(PID, ID_A.toString(), ALL_SCOPE, false, MALFORMED),
    ).rejects.toMatchObject({
      error: { code: status.NOT_FOUND },
    });
  });
});
