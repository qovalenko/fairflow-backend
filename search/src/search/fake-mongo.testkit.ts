/**
 * In-memory Mongo test double for the search domain specs (NOT a spec itself —
 * the jest testRegex only picks up `*.spec.ts`).
 *
 * It faithfully honours the operations the read/reindex/projection paths use:
 * find (cursor: async iteration + sort/limit/toArray/close), aggregate
 * ($match/$group/$addFields/$sort/$skip/$limit, evaluated in pipeline order —
 * the paged group query depends on that), countDocuments,
 * updateOne/updateMany ($set/$setOnInsert/$inc/
 * $max, upsert), bulkWrite (with the real "conflicting update operators" error)
 * and deleteMany — plus the filter operators the domain builds ($and/$or/$in/$lt/
 * $gt/$ne/$exists and RegExp).
 */

export interface Row extends Record<string, unknown> {
  _id: { toString: () => string };
}

export function matchFilter(
  doc: Record<string, unknown>,
  filter: Record<string, unknown>,
): boolean {
  for (const [key, cond] of Object.entries(filter)) {
    if (key === '$and') {
      if (!(cond as Record<string, unknown>[]).every((f) => matchFilter(doc, f))) return false;
      continue;
    }
    if (key === '$or') {
      if (!(cond as Record<string, unknown>[]).some((f) => matchFilter(doc, f))) return false;
      continue;
    }
    // The shared fail-closed DENY_ALL_FILTER is `$nor: [{}]` — `{}` matches every
    // document, so a `$nor` over it matches none. Supported here so specs can
    // exercise the deny-all path instead of blowing up in the matcher.
    if (key === '$nor') {
      if ((cond as Record<string, unknown>[]).some((f) => matchFilter(doc, f))) return false;
      continue;
    }
    const value = doc[key] === undefined ? null : doc[key];
    if (cond instanceof RegExp) {
      if (!(typeof value === 'string' && cond.test(value))) return false;
      continue;
    }
    if (cond && typeof cond === 'object') {
      for (const [op, operand] of Object.entries(cond as Record<string, unknown>)) {
        if (op === '$in') {
          if (!(Array.isArray(operand) && operand.some((o) => o === value || (o === null && value === null))))
            return false;
        } else if (op === '$nin') {
          if (Array.isArray(operand) && operand.includes(value as never)) return false;
        } else if (op === '$lt') {
          if (!((value as number) < (operand as number))) return false;
        } else if (op === '$gt') {
          if (!((value as number) > (operand as number))) return false;
        } else if (op === '$ne') {
          if (value === operand) return false;
        } else if (op === '$exists') {
          // Mongo semantics: an explicit `null` IS a present field. The search
          // index relies on that difference — a materialized-but-empty ABAC
          // attribute (`null`, written by the authoritative reindex) must pass
          // `$exists:true`, while an attribute the event path never learned
          // (field absent) must not.
          if ((key in doc) !== Boolean(operand)) return false;
        } else {
          throw new Error(`unsupported op in test matcher: ${op}`);
        }
      }
      continue;
    }
    if (value !== cond) return false;
  }
  return true;
}

/**
 * Aggregation-expression evaluator for the operator set the domain's scoring
 * pipeline uses ($add/$cond/$eq/$gte/$toLower/$ifNull/$indexOfCP + `"$field"`
 * paths). Deliberately narrow: an unknown operator throws instead of silently
 * evaluating to undefined, so a pipeline the double cannot honour fails the spec.
 */
export function evalExpr(expr: unknown, doc: Record<string, unknown>): unknown {
  if (typeof expr === 'string') {
    return expr.startsWith('$') ? doc[expr.slice(1)] : expr;
  }
  if (!expr || typeof expr !== 'object' || Array.isArray(expr)) return expr;
  const [op, rawArg] = Object.entries(expr as Record<string, unknown>)[0] as [string, unknown];
  const args = (Array.isArray(rawArg) ? rawArg : [rawArg]).map((a) => evalExpr(a, doc));
  switch (op) {
    case '$add':
      return args.reduce((acc: number, v) => acc + Number(v ?? 0), 0);
    case '$cond':
      return args[0] ? args[1] : args[2];
    case '$eq':
      return args[0] === args[1];
    case '$gte':
      return Number(args[0]) >= Number(args[1]);
    case '$toLower':
      return String(args[0] ?? '').toLowerCase();
    case '$ifNull':
      return args[0] === undefined || args[0] === null ? args[1] : args[0];
    case '$indexOfCP':
      return String(args[0] ?? '').indexOf(String(args[1] ?? ''));
    default:
      throw new Error(`unsupported aggregation expression in test double: ${op}`);
  }
}

/** Comparable form of a sort key ( `_id` is an opaque object in this double). */
function sortKey(v: unknown): number | string {
  if (typeof v === 'number') return v;
  if (v === undefined || v === null) return '';
  return String((v as { toString: () => string }).toString());
}

/** Equality fields of a filter that Mongo materializes into an upserted doc. */
function equalityFields(filter: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, cond] of Object.entries(filter)) {
    if (key.startsWith('$')) continue;
    if (cond instanceof RegExp) continue;
    if (cond && typeof cond === 'object') continue;
    out[key] = cond;
  }
  return out;
}

function applyUpdate(doc: Row, update: Record<string, unknown>): void {
  Object.assign(doc, (update.$set ?? {}) as Record<string, unknown>);
  for (const [k, v] of Object.entries((update.$inc ?? {}) as Record<string, number>)) {
    doc[k] = Number(doc[k] ?? 0) + Number(v);
  }
  for (const [k, v] of Object.entries((update.$max ?? {}) as Record<string, number>)) {
    doc[k] = Math.max(Number(doc[k] ?? 0), Number(v));
  }
}

let autoId = 0;

/** Mongo duplicate-key error (code 11000), as the domain's catch blocks expect. */
function duplicateKeyError(): Error & { code: number } {
  return Object.assign(new Error('E11000 duplicate key error collection'), { code: 11000 });
}

export class FakeCollection {
  readonly createdIndexes: Array<{ key: Record<string, unknown>; opts?: unknown }> = [];

  /**
   * Fields of the collection's unique index, if any. An upsert that has to
   * INSERT while a document with the same key already exists raises 11000 —
   * exactly the race the version-guarded upserts rely on.
   */
  constructor(
    public docs: Row[] = [],
    private readonly uniqueKey: string[] = [],
  ) {}

  private violatesUnique(doc: Record<string, unknown>): boolean {
    if (this.uniqueKey.length === 0) return false;
    return this.docs.some((d) => this.uniqueKey.every((k) => d[k] === doc[k]));
  }

  private sel(filter: Record<string, unknown>) {
    return this.docs.filter((d) => matchFilter(d, filter));
  }

  find(filter: Record<string, unknown> = {}) {
    const rows = this.sel(filter);
    const cursor = {
      sort: () => cursor,
      limit: () => cursor,
      toArray: async () => rows,
      close: async () => undefined,
      async *[Symbol.asyncIterator]() {
        for (const row of rows) yield row;
      },
    };
    return cursor;
  }

  async findOne(filter: Record<string, unknown> = {}) {
    return this.sel(filter)[0] ?? null;
  }

  /**
   * Sequential pipeline interpreter over the stages the domain actually builds:
   * `$match`, `$group` (count-by-field), `$addFields`, `$sort`, `$skip`, `$limit`.
   * Stages run in order, so the paged group query (TODO-261: addFields score →
   * sort → skip → limit) is evaluated the way Mongo evaluates it and a spec can
   * assert real page boundaries instead of a hand-rolled slice.
   */
  aggregate(pipeline: Array<Record<string, unknown>>) {
    let rows: Array<Record<string, unknown>> = this.docs;
    for (const stage of pipeline) {
      const [op, arg] = Object.entries(stage)[0] as [string, unknown];
      if (op === '$match') {
        rows = rows.filter((d) => matchFilter(d, arg as Record<string, unknown>));
      } else if (op === '$group') {
        const field = String((arg as { _id?: string })._id ?? '').replace(/^\$/, '');
        const counts = new Map<unknown, number>();
        for (const r of rows) {
          const key = r[field] === undefined ? null : r[field];
          counts.set(key, (counts.get(key) ?? 0) + 1);
        }
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
            const av = sortKey(a[k]);
            const bv = sortKey(b[k]);
            if (av < bv) return -dir;
            if (av > bv) return dir;
          }
          return 0;
        });
      } else if (op === '$skip') {
        rows = rows.slice(Number(arg));
      } else if (op === '$limit') {
        rows = rows.slice(0, Number(arg));
      } else {
        throw new Error(`unsupported aggregation stage in test double: ${op}`);
      }
    }
    const out = rows;
    return { toArray: async () => out };
  }

  async countDocuments(filter: Record<string, unknown> = {}, opts?: { limit?: number }) {
    const n = this.sel(filter).length;
    return opts?.limit ? Math.min(n, opts.limit) : n;
  }

  async updateOne(
    filter: Record<string, unknown>,
    update: Record<string, unknown>,
    opts?: { upsert?: boolean },
  ) {
    const existing = this.sel(filter)[0];
    if (existing) {
      applyUpdate(existing, update);
      return { matchedCount: 1, modifiedCount: 1, upsertedCount: 0 };
    }
    if (opts?.upsert) {
      const doc = {
        ...equalityFields(filter),
        ...((update.$setOnInsert ?? {}) as Record<string, unknown>),
      } as Row;
      applyUpdate(doc, update);
      if (this.violatesUnique(doc)) throw duplicateKeyError();
      if (!doc._id) {
        autoId += 1;
        const id = `auto-${autoId}`;
        doc._id = { toString: () => id };
      }
      this.docs.push(doc);
      return { matchedCount: 0, modifiedCount: 0, upsertedCount: 1 };
    }
    return { matchedCount: 0, modifiedCount: 0, upsertedCount: 0 };
  }

  async updateMany(filter: Record<string, unknown>, update: Record<string, unknown>) {
    const rows = this.sel(filter);
    for (const row of rows) applyUpdate(row, update);
    return { matchedCount: rows.length, modifiedCount: rows.length };
  }

  async deleteMany(filter: Record<string, unknown>) {
    const before = this.docs.length;
    this.docs = this.docs.filter((d) => !matchFilter(d, filter));
    return { deletedCount: before - this.docs.length };
  }

  async bulkWrite(
    ops: Array<{
      updateOne: {
        filter: Record<string, unknown>;
        update: Record<string, unknown>;
        upsert?: boolean;
      };
    }>,
  ) {
    for (const op of ops) {
      const { filter, update, upsert } = op.updateOne;
      const set = (update.$set ?? {}) as Record<string, unknown>;
      const max = (update.$max ?? {}) as Record<string, unknown>;
      // Mimic Mongo: the same field path may not appear in two update operators.
      // reindex used to put `version` in BOTH $set and $max → real Mongo rejected
      // the whole bulkWrite ("would create a conflict at 'version'") and the index
      // stayed empty. Guard so this regression fails the test, not just runtime.
      for (const k of Object.keys(max)) {
        if (k in set) {
          throw new Error(`Updating the path '${k}' would create a conflict at '${k}'`);
        }
      }
      const existing = this.sel(filter)[0];
      if (existing) {
        applyUpdate(existing, update);
      } else if (upsert) {
        const doc = { ...equalityFields(filter) } as Row;
        applyUpdate(doc, update);
        if (this.violatesUnique(doc)) throw duplicateKeyError();
        if (!doc._id) {
          doc._id = { toString: () => `${String(filter.entityType)}:${String(filter.entityId)}` };
        }
        this.docs.push(doc);
      }
    }
    return { ok: 1 };
  }

  async createIndex(key: Record<string, unknown>, opts?: unknown) {
    this.createdIndexes.push({ key, opts });
    return 'ok';
  }
}

export interface FakeMongoSeed {
  index?: Row[];
  state?: Row[];
  dedup?: Row[];
  contacts?: Row[];
  companies?: Row[];
  deals?: Row[];
  orders?: Row[];
  products?: Row[];
  activities?: Row[];
}

/** Build a MongoService test double over in-memory collections. */
export function buildMongo(seed: FakeMongoSeed = {}) {
  // The real search_index carries uq_project_type_entity — simulate it so the
  // out-of-order paths hit the same 11000 they suppress in production.
  const index = new FakeCollection(seed.index ?? [], ['projectId', 'entityType', 'entityId']);
  // TODO-491: `search_index_state` carries uq_state_project (one bookkeeping row
  // per project) — simulate it so a second insert races the way it does in Mongo.
  const state = new FakeCollection(seed.state ?? [], ['projectId']);
  const dedup = new FakeCollection(seed.dedup ?? []);
  const contacts = new FakeCollection(seed.contacts ?? []);
  const companies = new FakeCollection(seed.companies ?? []);
  const deals = new FakeCollection(seed.deals ?? []);
  const orders = new FakeCollection(seed.orders ?? []);
  const products = new FakeCollection(seed.products ?? []);
  const activities = new FakeCollection(seed.activities ?? []);
  const mongo = {
    searchIndex: () => index,
    searchIndexState: () => state,
    searchEventDedup: () => dedup,
    contacts: () => contacts,
    companies: () => companies,
    deals: () => deals,
    orders: () => orders,
    products: () => products,
    activities: () => activities,
  };
  return { mongo, index, state, dedup, contacts, companies, deals, orders, products, activities };
}

/** Convenience row factory with a stable `_id.toString()`. */
export function row(id: string, fields: Record<string, unknown>): Row {
  return { _id: { toString: () => id }, ...fields };
}
