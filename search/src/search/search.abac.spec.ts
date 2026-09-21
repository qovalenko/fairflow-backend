/**
 * P8 T3.2b: the search domain must apply the gateway-resolved ABAC predicate
 * (`x-access-predicate`) fail-CLOSED. A malformed predicate is a broken deny-rule
 * and must yield an EMPTY result across every search path (main list,
 * total_by_type / groups / total_by_owner aggregations), never a silently-widened
 * (fail-open) read — the AS-IS bug this task closes.
 *
 * The tests wire the REAL SearchService against an in-memory index collection whose
 * matcher faithfully evaluates the Mongo fragment shapes `compileMongo` emits, so a
 * deny-predicate provably filters rows exactly as Mongo would. The predicate is
 * built with the shared pipeline (parse → normalize → compileMongo) — the same one
 * the gateway runs — so the domain is tested against contract output.
 */
import {
  compileMongoRaw,
  normalizeAbac,
  type AbacNode,
  type VisibilityScope,
} from '@fairflow/shared';
import { SearchService, type SearchAccessContext } from './search.service';
// Only the aggregation-EXPRESSION evaluator is borrowed; the filter matcher below
// stays local on purpose — it is what makes this spec a faithful check of the
// `compileMongo` output shapes.
import { evalExpr } from './fake-mongo.testkit';

// Search index docs are default-visibility "all" here (mode:'all' → no owner
// narrowing) so the tests isolate ABAC from visibility, not the fail-closed
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

function matchOps(value: unknown, ops: Record<string, unknown>, present: boolean): boolean {
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
        if (!(typeof value === typeof operand && (value as number) > (operand as number))) return false;
        break;
      case '$gte':
        if (!(typeof value === typeof operand && (value as number) >= (operand as number))) return false;
        break;
      case '$lt':
        if (!(typeof value === typeof operand && (value as number) < (operand as number))) return false;
        break;
      case '$lte':
        if (!(typeof value === typeof operand && (value as number) <= (operand as number))) return false;
        break;
      case '$exists':
        // Mongo semantics: `null` is a PRESENT field (see fake-mongo.testkit).
        if (present !== Boolean(operand)) return false;
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
        if (!matchOps(value, cond as Record<string, unknown>, key in doc)) return false;
        continue;
      }
    }
    if (value !== cond) return false;
  }
  return true;
}

// ── in-memory index collection (find + aggregate($match/$group)) ──────────────
class FakeIndex {
  constructor(private docs: Record<string, unknown>[]) {}
  private sel(filter: Record<string, unknown>) {
    return this.docs.filter((d) => matchFilter(d, filter));
  }
  find(filter: Record<string, unknown> = {}) {
    const rows = this.sel(filter);
    const cursor = {
      sort: () => cursor,
      limit: () => cursor,
      toArray: async () => rows,
    };
    return cursor;
  }
  /**
   * Stages are executed IN ORDER, not pattern-matched positionally: besides the
   * count aggregations this double now also serves the paged group query
   * (TODO-261: $match → $addFields(score) → $sort → $skip → $limit). A positional
   * `pipeline[1].$group` reading would silently turn that pipeline into a
   * group-by-nothing and hand the domain rows without `_id`.
   */
  aggregate(pipeline: Array<Record<string, unknown>>) {
    let rows: Record<string, unknown>[] = this.docs;
    for (const stage of pipeline) {
      const [op, arg] = Object.entries(stage)[0] as [string, unknown];
      if (op === '$match') {
        rows = rows.filter((d) => matchFilter(d, arg as Record<string, unknown>));
      } else if (op === '$group') {
        const field = String((arg as { _id?: string })._id ?? '').replace(/^\$/, '');
        const counts = new Map<unknown, number>();
        for (const r of rows) counts.set(getField(r, field), (counts.get(getField(r, field)) ?? 0) + 1);
        rows = [...counts.entries()].map(([_id, n]) => ({ _id, n }));
      } else if (op === '$addFields') {
        rows = rows.map((r) => {
          const next = { ...r };
          for (const [field, expr] of Object.entries(arg as Record<string, unknown>)) {
            next[field] = evalExpr(expr, r);
          }
          return next;
        });
      } else if (op === '$sort') {
        const keys = Object.entries(arg as Record<string, number>);
        rows = [...rows].sort((a, b) => {
          for (const [k, dir] of keys) {
            const av = String(a[k] ?? '');
            const bv = String(b[k] ?? '');
            const num = typeof a[k] === 'number' && typeof b[k] === 'number';
            const cmp = num
              ? (a[k] as number) - (b[k] as number)
              : av < bv
                ? -1
                : av > bv
                  ? 1
                  : 0;
            if (cmp !== 0) return cmp * dir;
          }
          return 0;
        });
      } else if (op === '$skip') {
        rows = rows.slice(Number(arg));
      } else if (op === '$limit') {
        rows = rows.slice(0, Number(arg));
      } else {
        throw new Error(`unsupported aggregation stage in test matcher: ${op}`);
      }
    }
    const out = rows;
    return { toArray: async () => out };
  }
  async countDocuments(filter: Record<string, unknown> = {}) {
    return this.sel(filter).length;
  }
}

function buildService(docs: Record<string, unknown>[]): SearchService {
  const index = new FakeIndex(docs);
  const mongo = { searchIndex: () => index } as unknown as {
    searchIndex: () => FakeIndex;
  };
  return new SearchService(mongo as never);
}

// Compiled predicate as the gateway would serialize it: `record.subtitle == "gold"`.
// (subtitle is an indexed, materialized field on the search doc.)
const SUBTITLE_EQ: AbacNode = {
  op: 'eq',
  left: { ref: 'record.subtitle' },
  right: { lit: 'gold' },
};
function presentMongo(ir: AbacNode): Record<string, unknown> {
  return compileMongoRaw(normalizeAbac(ir)) as Record<string, unknown>;
}

const PID = 'proj-1';
function seed() {
  const now = Date.now();
  const doc = (
    entityType: string,
    entityId: string,
    title: string,
    subtitle: string,
    projectId = PID,
  ) => ({
    _id: { toString: () => `${entityType}:${entityId}` },
    projectId,
    entityType,
    entityId,
    title,
    subtitle,
    path: `/p/${projectId}/${entityType}s/${entityId}`,
    tokens: `${title} ${subtitle}`.toLowerCase(),
    ownerId: 'user-1',
    departmentId: null,
    ownerField: 'ownerId',
    abacAttrs: {},
    sourceUpdatedAt: now,
    deletedAt: null,
    version: now,
    updatedAt: now,
  });
  return [
    doc('contact', 'a', 'Alpha widget', 'gold'), // passes subtitle==gold
    doc('contact', 'b', 'Alpha gadget', 'silver'), // fails the predicate
    // Different-project row (also matches the query): proves projectId isolation
    // is AND-ed ahead of ABAC and never leaks.
    doc('contact', 'c', 'Alpha other', 'gold', 'other'),
  ];
}

const absentCtx = (): SearchAccessContext => ({ scope: ALL_SCOPE });
const presentCtx = (): SearchAccessContext => ({
  scope: ALL_SCOPE,
  accessPredicate: presentMongo(SUBTITLE_EQ),
});
const malformedCtx = (): SearchAccessContext => ({ scope: ALL_SCOPE, accessMalformed: true });

describe('search ABAC predicate fail-closed (P8 T3.2b)', () => {
  // These tests isolate the ABAC PEP, not the T-018 lazy backfill: the fake mongo
  // only stubs `searchIndex`, so disable the backfill (which would touch
  // `searchIndexState`/source collections) to keep the read path pure and quiet.
  const OLD_BACKFILL = process.env.SEARCH_LAZY_BACKFILL;
  beforeAll(() => {
    process.env.SEARCH_LAZY_BACKFILL = 'false';
  });
  afterAll(() => {
    if (OLD_BACKFILL === undefined) delete process.env.SEARCH_LAZY_BACKFILL;
    else process.env.SEARCH_LAZY_BACKFILL = OLD_BACKFILL;
  });

  it('valid predicate (subtitle == gold) narrows the result', async () => {
    const svc = buildService(seed());
    const res = await svc.search(PID, 'alpha', 0, 25, {
      entityTypes: ['contact'],
      ctx: presentCtx(),
    });
    expect(res.list.map((h) => h.entity_id)).toEqual(['a']); // b (silver) filtered, other project excluded
    expect(res.total).toBe(1);
    expect(res.total_by_type).toEqual({ contact: 1 });
  });

  it('absent predicate does not change the result', async () => {
    const svc = buildService(seed());
    const withAbsent = await svc.search(PID, 'alpha', 0, 25, {
      entityTypes: ['contact'],
      ctx: absentCtx(),
    });
    // Baseline: same visibility scope, ABAC field simply not set. An absent
    // predicate must be a no-op — identical result, no narrowing, no deny.
    const baseline = await svc.search(PID, 'alpha', 0, 25, {
      entityTypes: ['contact'],
      ctx: { scope: ALL_SCOPE },
    });
    expect(withAbsent.list.map((h) => h.entity_id).sort()).toEqual(['a', 'b']);
    expect(withAbsent.total).toBe(2); // both project rows, other-project excluded by projectId
    expect(withAbsent).toEqual(baseline);
  });

  it('malformed predicate is fail-closed: empty across list, total_by_type and total', async () => {
    const svc = buildService(seed());
    const res = await svc.search(PID, 'alpha', 0, 25, {
      entityTypes: ['contact'],
      ctx: malformedCtx(),
    });
    expect(res.list).toEqual([]);
    expect(res.total).toBe(0);
    expect(res.groups).toEqual([]);
    expect(res.total_by_type).toEqual({});
  });

  it('malformed predicate is fail-closed for the groupBy owner aggregation too', async () => {
    const svc = buildService(seed());
    const res = await svc.search(PID, 'alpha', 0, 25, {
      entityTypes: ['contact'],
      groupBy: 'ownerId',
      ctx: malformedCtx(),
    });
    expect(res.list).toEqual([]);
    expect(res.total).toBe(0);
    expect(res.total_by_owner).toEqual({});
  });
});

/**
 * review-1: the CROSS-ENTITY predicate the gateway now emits for `/search/query`
 * (one `entityType`-guarded disjunct per data-subject) must behave, once ANDed
 * into the read filter, exactly as the PEP intends:
 *  - a module's rule narrows ONLY that module's rows,
 *  - a subject the gateway dropped (blanket DENY / uncompilable rules) disappears
 *    from the list AND from every aggregation derived from the base filter.
 *
 * The wire shape asserted here is pinned on the producer side by
 * `gateway/src/guards/access-predicate.cross-entity.spec.ts`; this spec is the
 * consumer half of the same contract.
 */
describe('search ABAC predicate is cross-entity (review-1)', () => {
  const OLD_BACKFILL = process.env.SEARCH_LAZY_BACKFILL;
  beforeAll(() => {
    process.env.SEARCH_LAZY_BACKFILL = 'false';
  });
  afterAll(() => {
    if (OLD_BACKFILL === undefined) delete process.env.SEARCH_LAZY_BACKFILL;
    else process.env.SEARCH_LAZY_BACKFILL = OLD_BACKFILL;
  });

  const now = Date.now();
  const row = (entityType: string, entityId: string, extra: Record<string, unknown> = {}) => ({
    _id: { toString: () => `${entityType}:${entityId}` },
    projectId: PID,
    entityType,
    entityId,
    title: `Alpha ${entityId}`,
    subtitle: 'x',
    path: `/p/${PID}/${entityType}s/${entityId}`,
    tokens: `alpha ${entityId}`,
    ownerId: 'user-1',
    departmentId: null,
    ownerField: 'ownerId',
    abacAttrs: {},
    sourceUpdatedAt: now,
    deletedAt: null,
    version: now,
    updatedAt: now,
    ...extra,
  });

  // Two deals (one over the ABAC threshold) + one contact + one company.
  const docs = () => [
    row('deal', 'small', { amount: 10 }),
    row('deal', 'big', { amount: 5_000_000 }),
    row('contact', 'c1'),
    row('company', 'co1'),
  ];

  const TYPES = ['deal', 'contact', 'company'];

  it('applies the deals rule to deals only and leaves the other types intact', async () => {
    const svc = buildService(docs());
    const res = await svc.search(PID, 'alpha', 0, 25, {
      entityTypes: TYPES,
      ctx: {
        scope: ALL_SCOPE,
        accessPredicate: {
          $or: [
            { $and: [{ entityType: 'deal' }, { $nor: [{ amount: { $gt: 1_000_000 } }] }] },
            { entityType: 'contact' },
            { entityType: 'company' },
          ],
        },
      },
    });
    expect(res.list.map((h) => h.entity_id).sort()).toEqual(['c1', 'co1', 'small']);
    // The million-plus deal never leaves the DB — its title/subtitle/path do not leak.
    expect(JSON.stringify(res.list)).not.toContain('big');
    expect(res.total_by_type).toEqual({ deal: 1, contact: 1, company: 1 });
  });

  it('a subject the gateway dropped is absent from the list AND the aggregations', async () => {
    const svc = buildService(docs());
    const res = await svc.search(PID, 'alpha', 0, 25, {
      entityTypes: TYPES,
      // `contacts` blanket-DENYed on the project → no `contact` disjunct at all.
      ctx: {
        scope: ALL_SCOPE,
        accessPredicate: { $or: [{ entityType: 'deal' }, { entityType: 'company' }] },
      },
    });
    expect(res.list.map((h) => h.entity_id).sort()).toEqual(['big', 'co1', 'small']);
    expect(res.total_by_type.contact).toBeUndefined();
    expect(res.total).toBe(3);
  });

  it('an all-dropped predicate empties the read without leaking existence', async () => {
    const svc = buildService(docs());
    const res = await svc.search(PID, 'alpha', 0, 25, {
      entityTypes: TYPES,
      ctx: { scope: ALL_SCOPE, accessPredicate: { entityType: { $in: [] } } },
    });
    expect(res.list).toEqual([]);
    expect(res.total).toBe(0);
    expect(res.total_by_type).toEqual({});
  });
});
