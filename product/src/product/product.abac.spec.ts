/**
 * P8 T3.2 (E2-08): the product domain must apply the gateway-resolved ABAC
 * predicate (`x-access-predicate`) on every read path and mutation gate.
 *
 * These tests wire the REAL ProductService against an in-memory collection whose
 * matcher faithfully evaluates the Mongo fragment shapes that `compileMongo`
 * emits ($and/$or/$nor/$eq/$ne/$in/$nin/$gt.../$exists + equality + RegExp), so a
 * deny-predicate provably filters rows exactly as Mongo would. The predicate is
 * built with the shared pipeline (parse → normalize → compileMongo) — the same
 * one the gateway runs — so the domain side is tested against contract output,
 * not a hand-rolled fragment.
 */
import {
  compileMongoRaw,
  normalizeAbac,
  type AbacNode,
  type AccessPredicate,
  type VisibilityScope,
} from '@fairflow/shared';
import { ProductService } from './product.service';

// Products are default-visibility "all": the gateway resolves a mode:'all' scope,
// which `buildVisibilityFilter` maps to NO record narrowing — this isolates ABAC
// from visibility so the tests exercise the predicate, not the (Д-3) fail-closed
// deny-all that an *undefined* scope would trigger.
const ALL_SCOPE: VisibilityScope = {
  mode: 'all',
  level: 'custom',
  selfId: 'user-1',
  ownerIds: [],
  sharedRecordIds: [],
};

// ── minimal, faithful Mongo filter matcher ────────────────────────────────────
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
    // scalar equality (handles ObjectId-like via toString compare)
    if (cond && typeof cond === 'object' && 'toString' in (cond as object)) {
      if (String(value) !== String(cond)) return false;
      continue;
    }
    if (value !== cond) return false;
  }
  return true;
}

// ── in-memory collections ─────────────────────────────────────────────────────
class FakeCollection {
  constructor(private docs: Record<string, unknown>[]) {}
  private sel(filter: Record<string, unknown>) {
    return this.docs.filter((d) => matchFilter(d, filter));
  }
  find(filter: Record<string, unknown> = {}) {
    let rows = this.sel(filter);
    const cursor = {
      sort: () => cursor,
      skip: (n: number) => {
        rows = rows.slice(n);
        return cursor;
      },
      limit: (n: number) => {
        rows = rows.slice(0, n);
        return cursor;
      },
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
  async distinct(field: string, filter: Record<string, unknown> = {}) {
    return [...new Set(this.sel(filter).map((d) => d[field]))];
  }
  async insertOne() {
    return { acknowledged: true };
  }
  async findOneAndUpdate(filter: Record<string, unknown>) {
    return this.sel(filter)[0] ?? null;
  }
  async updateOne() {
    return { modifiedCount: 1 };
  }
}

function buildService(docs: Record<string, unknown>[]): ProductService {
  const collection = new FakeCollection(docs);
  const mongo = { products: () => collection } as unknown as { products: () => FakeCollection };
  // outbox.withOutbox runs the callback with no session (single-node test path).
  const outbox = {
    withOutbox: async (
      fn: (session: unknown) => Promise<{ result: unknown; intents: unknown[] }>,
    ) => (await fn(undefined)).result,
  };
  return new ProductService(mongo as never, outbox as never);
}

// Compiled predicate as the gateway would serialize it (normalize → compileMongo,
// plus the residual IR for the single-record gate). `record.category == "gold"`.
const CATEGORY_EQ: AbacNode = {
  op: 'eq',
  left: { ref: 'record.category' },
  right: { lit: 'gold' },
};
function present(ir: AbacNode): AccessPredicate {
  const normalized = normalizeAbac(ir);
  return { present: true, mongo: compileMongoRaw(normalized), ir: normalized as AbacNode };
}
const ABSENT: AccessPredicate = { present: false };
const MALFORMED: AccessPredicate = { present: true, malformed: true };

const PID = 'proj-1';
// Real 24-hex ObjectId strings so the get/update/archive paths (ObjectId.isValid +
// new ObjectId(id)) resolve the record — otherwise an invalid id would short-circuit
// to NOT_FOUND and mask whether the ABAC gate (not id validation) did the denying.
const ID_A = 'aaaaaaaaaaaaaaaaaaaaaaaa'; // category gold  (passes `category == gold`)
const ID_B = 'bbbbbbbbbbbbbbbbbbbbbbbb'; // category silver (fails the predicate)
function seed() {
  return [
    { _id: ID_A, projectId: PID, name: 'Alpha', category: 'gold', status: 'active', price: 100 },
    { _id: ID_B, projectId: PID, name: 'Bravo', category: 'silver', status: 'active', price: 200 },
    // Different-project row: exercises that projectId isolation is still AND-ed
    // ahead of the ABAC predicate.
    {
      _id: 'cccccccccccccccccccccccc',
      projectId: 'other',
      name: 'Other',
      category: 'gold',
      status: 'active',
      price: 1,
    },
  ];
}

// Products are default-visibility "all"; keep visibility neutral to isolate ABAC.
describe('product ABAC predicate (E2-08 / T3.2)', () => {
  it('list: deny predicate (category == gold) keeps only matching rows', async () => {
    const svc = buildService(seed());
    const res = await svc.list(PID, 0, 25, { scope: ALL_SCOPE, access: present(CATEGORY_EQ) });
    expect(res.list.map((r) => r.id)).toEqual([ID_A]); // Bravo (silver) filtered, other project excluded
    expect(res.total).toBe(1);
  });

  it('list: absent predicate does not change the result', async () => {
    const svc = buildService(seed());
    const withAbsent = await svc.list(PID, 0, 25, { scope: ALL_SCOPE, access: ABSENT });
    const without = await svc.list(PID, 0, 25, { scope: ALL_SCOPE });
    expect(withAbsent.list.map((r) => r.id).sort()).toEqual([ID_A, ID_B].sort());
    expect(withAbsent.total).toBe(2);
    expect(withAbsent).toEqual(without);
  });

  it('list: malformed predicate is fail-closed (empty)', async () => {
    const svc = buildService(seed());
    const res = await svc.list(PID, 0, 25, { scope: ALL_SCOPE, access: MALFORMED });
    expect(res.list).toEqual([]);
    expect(res.total).toBe(0);
  });

  it('get: record failing the predicate is NOT_FOUND', async () => {
    const svc = buildService(seed());
    await expect(svc.get(PID, ID_B, ALL_SCOPE, present(CATEGORY_EQ))).rejects.toMatchObject({
      error: { code: 5 }, // NOT_FOUND
    });
    // and a passing record is returned
    const ok = await svc.get(PID, ID_A, ALL_SCOPE, present(CATEGORY_EQ));
    expect(ok.id).toBe(ID_A);
  });

  it('get: absent predicate returns the record unchanged', async () => {
    const svc = buildService(seed());
    const ok = await svc.get(PID, ID_B, ALL_SCOPE, ABSENT);
    expect(ok.id).toBe(ID_B);
  });

  it('get: malformed predicate is fail-closed (NOT_FOUND even for existing row)', async () => {
    const svc = buildService(seed());
    await expect(svc.get(PID, ID_A, ALL_SCOPE, MALFORMED)).rejects.toMatchObject({
      error: { code: 5 },
    });
  });

  it('update: mutation on a record failing the predicate is denied (NOT_FOUND)', async () => {
    const svc = buildService(seed());
    await expect(
      svc.update(PID, ID_B, { name: 'x' }, 'user-1', present(CATEGORY_EQ)),
    ).rejects.toMatchObject({ error: { code: 5 } });
  });

  it('archive: mutation on a passing record proceeds; failing record denied', async () => {
    const svc = buildService(seed());
    await expect(svc.archive(PID, ID_B, 'user-1', present(CATEGORY_EQ))).rejects.toMatchObject({
      error: { code: 5 },
    });
    // passing record: archive of ID_A (category gold, active) succeeds
    const res = await svc.archive(PID, ID_A, 'user-1', present(CATEGORY_EQ));
    expect(res.ok).toBe(true);
  });

  it('listCategories: predicate narrows the distinct category set', async () => {
    const svc = buildService(seed());
    const denied = await svc.listCategories(PID, ALL_SCOPE, present(CATEGORY_EQ));
    expect(denied.categories).toEqual(['gold']);
    const malformed = await svc.listCategories(PID, ALL_SCOPE, MALFORMED);
    expect(malformed.categories).toEqual([]);
  });
});
