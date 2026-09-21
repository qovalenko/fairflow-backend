/**
 * ABAC push-down (P2.d / E2-08): the contact domain must apply the gateway-resolved
 * ABAC predicate (`x-access-predicate`) on its read paths — by the product/search
 * reference. Three-state semantics (shared/grpc/inbound-metadata):
 *   absent    → no ABAC narrowing (projectId + visibility only);
 *   malformed → fail-closed DENY (broken deny-rule must never widen access);
 *   present   → AND the compiled `.mongo` fragment / gate single records via `.ir`.
 *
 * The predicate is built with the shared pipeline (normalize → compileMongoRaw) — the
 * same one the gateway runs — so the domain is tested against contract output.
 */
import {
  compileMongoRaw,
  normalizeAbac,
  type AbacNode,
  type AccessPredicate,
  type VisibilityScope,
} from '@fairflow/shared';
import { ContactsService } from './contacts.service';

// mode:'all' → buildVisibilityFilter yields NO narrowing and isRecordVisible is true,
// isolating the ABAC dimension from visibility (Д-3 fail-closed on undefined scope).
const ALL_SCOPE: VisibilityScope = {
  mode: 'all',
  level: 'custom',
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

function buildService(docs: Record<string, unknown>[]): ContactsService {
  const collection = new FakeCollection(docs);
  const mongo = { contacts: () => collection } as unknown as { contacts: () => FakeCollection };
  const outbox = {
    withOutbox: async (fn: (s: unknown) => Promise<{ result: unknown }>) =>
      (await fn(undefined)).result,
  };
  return new ContactsService(mongo as never, outbox as never);
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
const ID_A = 'aaaaaaaaaaaaaaaaaaaaaaaa'; // source web  → passes
const ID_B = 'bbbbbbbbbbbbbbbbbbbbbbbb'; // source cold → fails
function seed() {
  const now = new Date();
  return [
    {
      _id: ID_A,
      projectId: PID,
      firstName: 'Alpha',
      lastName: 'A',
      ownerId: 'user-1',
      source: 'web',
      deletedAt: null,
      createdAt: now,
      updatedAt: now,
    },
    {
      _id: ID_B,
      projectId: PID,
      firstName: 'Bravo',
      lastName: 'B',
      ownerId: 'user-1',
      source: 'cold',
      deletedAt: null,
      createdAt: now,
      updatedAt: now,
    },
    {
      _id: 'cccccccccccccccccccccccc',
      projectId: 'other',
      firstName: 'X',
      lastName: 'X',
      ownerId: 'user-1',
      source: 'web',
      deletedAt: null,
      createdAt: now,
      updatedAt: now,
    },
  ];
}

describe('contact ABAC predicate push-down (P2.d)', () => {
  it('list: present predicate (source == web) keeps only matching rows', async () => {
    const svc = buildService(seed());
    const res = await svc.list(PID, 0, 25, undefined, ALL_SCOPE, present(SOURCE_EQ));
    expect(res.list.map((r) => r.id)).toEqual([ID_A]);
    expect(res.total).toBe(1);
  });

  it('list: absent predicate does not change the result', async () => {
    const svc = buildService(seed());
    const withAbsent = await svc.list(PID, 0, 25, undefined, ALL_SCOPE, ABSENT);
    const without = await svc.list(PID, 0, 25, undefined, ALL_SCOPE);
    expect(withAbsent.list.map((r) => r.id).sort()).toEqual([ID_A, ID_B].sort());
    expect(withAbsent).toEqual(without);
  });

  it('list: malformed predicate is fail-closed (empty)', async () => {
    const svc = buildService(seed());
    const res = await svc.list(PID, 0, 25, undefined, ALL_SCOPE, MALFORMED);
    expect(res.list).toEqual([]);
    expect(res.total).toBe(0);
  });

  it('findOne: record failing the predicate is NOT_FOUND, passing returned', async () => {
    const svc = buildService(seed());
    await expect(svc.findOne(PID, ID_B, ALL_SCOPE, present(SOURCE_EQ))).rejects.toMatchObject({
      errorCode: 'notFound',
    });
    const ok = await svc.findOne(PID, ID_A, ALL_SCOPE, present(SOURCE_EQ));
    expect(ok.id).toBe(ID_A);
  });

  it('findOne: malformed predicate is fail-closed (NOT_FOUND even for existing row)', async () => {
    const svc = buildService(seed());
    await expect(svc.findOne(PID, ID_A, ALL_SCOPE, MALFORMED)).rejects.toMatchObject({
      errorCode: 'notFound',
    });
  });
});
