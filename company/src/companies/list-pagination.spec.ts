/**
 * Stable pagination (companies.service `list`/`listTrash`).
 *
 * `list()` pages with `.skip(pageIndex * pageSize).limit(pageSize)`, which is only
 * correct if the sort is a TOTAL order. Sorting by `updatedAt` alone is NOT: a CSV
 * import or a bulk edit stamps many rows with the same millisecond, and Mongo makes
 * no promise about the order among equal keys — the same row can then land on two
 * consecutive pages while another is skipped entirely. The gateway export walks up
 * to 100 pages and would silently duplicate/drop rows without tripping
 * `X-Export-Truncated`. Hence the `_id` tie-breaker in the sort spec.
 *
 * The fake collection below reproduces the hazard faithfully: it applies the sort
 * spec the service passes (multi-key, Mongo-like), and the physical document order
 * is shuffled between the two page queries — exactly the freedom a real storage
 * engine has for rows that compare equal.
 */
import type { VisibilityScope } from '@fairflow/shared';
import { CompaniesService } from './companies.service';

const PID = 'proj-1';
const SCOPE: VisibilityScope = {
  mode: 'all',
  level: 'custom',
  selfId: 'user-1',
  ownerIds: [],
  sharedRecordIds: [],
};

type Doc = Record<string, unknown>;

interface FakeCursor {
  sort(spec: Record<string, 1 | -1>): FakeCursor;
  skip(n: number): FakeCursor;
  limit(n: number): FakeCursor;
  toArray(): Promise<Doc[]>;
}

function cmp(a: unknown, b: unknown): number {
  const av = a instanceof Date ? a.getTime() : a;
  const bv = b instanceof Date ? b.getTime() : b;
  if (typeof av === 'number' && typeof bv === 'number') return av === bv ? 0 : av < bv ? -1 : 1;
  const as = String(av ?? '');
  const bs = String(bv ?? '');
  return as === bs ? 0 : as < bs ? -1 : 1;
}

class FakeCollection {
  /** Sort specs seen by this collection, in call order. */
  readonly sorts: Record<string, 1 | -1>[] = [];

  constructor(private docs: Doc[]) {}

  private sel(filter: Doc): Doc[] {
    // Only the predicates `list()` builds for this fixture matter: projectId + deletedAt.
    const and = (filter.$and ?? []) as Doc[];
    const flat: Doc[] = [filter, ...and];
    return this.docs.filter((d) =>
      flat.every((f) =>
        Object.entries(f).every(([k, v]) => {
          if (k === '$and' || k === '$or') return true;
          if (v === null) return d[k] == null;
          // `listTrash` passes `{ deletedAt: { $ne: null } }`.
          if (v && typeof v === 'object' && '$ne' in (v as Doc)) {
            const operand = (v as Doc).$ne;
            return operand === null ? d[k] != null : d[k] !== operand;
          }
          return d[k] === v;
        }),
      ),
    );
  }

  find(filter: Doc = {}) {
    // Mongo applies sort BEFORE skip/limit regardless of the chaining order, so the
    // cursor only records options and materialises in `toArray()`.
    let sortSpec: Record<string, 1 | -1> | null = null;
    let skipN = 0;
    let limitN = Number.MAX_SAFE_INTEGER;
    const cursor: FakeCursor = {
      sort: (spec: Record<string, 1 | -1>) => {
        sortSpec = spec;
        this.sorts.push(spec);
        return cursor;
      },
      skip: (n: number) => {
        skipN = n;
        return cursor;
      },
      limit: (n: number) => {
        limitN = n;
        return cursor;
      },
      toArray: async () => {
        let rows = this.sel(filter);
        if (sortSpec) {
          const entries = Object.entries(sortSpec);
          rows = [...rows].sort((x, y) => {
            for (const [field, dir] of entries) {
              const c = cmp(x[field], y[field]);
              if (c !== 0) return c * dir;
            }
            return 0; // equal under the whole spec → order is whatever the input was
          });
        }
        return rows.slice(skipN, skipN + limitN);
      },
    };
    return cursor;
  }

  async countDocuments(filter: Doc = {}) {
    return this.sel(filter).length;
  }

  /** Simulates the storage engine handing back equal-key rows in another order. */
  shuffle(): void {
    this.docs.reverse();
  }
}

function buildService(docs: Doc[]): { svc: CompaniesService; coll: FakeCollection } {
  const coll = new FakeCollection(docs);
  const mongo = { companies: () => coll } as unknown as { companies: () => FakeCollection };
  const outbox = { withOutbox: async () => undefined };
  return { svc: new CompaniesService(mongo as never, outbox as never), coll };
}

/** Four live companies sharing one `updatedAt` — the post-import / bulk-edit shape. */
function seed(deleted = false): Doc[] {
  const same = new Date('2026-01-01T00:00:00.000Z');
  return ['a', 'b', 'c', 'd'].map((c) => ({
    _id: c.repeat(24),
    projectId: PID,
    name: `Co ${c.toUpperCase()}`,
    ownerId: 'user-1',
    deletedAt: deleted ? same : null,
    createdAt: same,
    updatedAt: same,
  }));
}

describe('companies list — stable pagination over equal sort keys', () => {
  it('sort spec carries an _id tie-breaker in the same direction as the primary key', async () => {
    const { svc, coll } = buildService(seed());
    await svc.list(PID, { pageSize: 2 }, SCOPE);
    expect(coll.sorts[0]).toEqual({ updatedAt: -1, _id: -1 });

    await svc.list(PID, { pageSize: 2, sortBy: 'name', sortDir: 'asc' }, SCOPE);
    expect(coll.sorts[1]).toEqual({ name: 1, _id: 1 });
  });

  it('two records with equal updatedAt do not migrate between pages', async () => {
    const { svc, coll } = buildService(seed());
    const page0 = await svc.list(PID, { pageIndex: 0, pageSize: 2 }, SCOPE);
    coll.shuffle(); // storage order changes between the two page requests
    const page1 = await svc.list(PID, { pageIndex: 1, pageSize: 2 }, SCOPE);

    const ids = [...page0.list.map((r) => r.id), ...page1.list.map((r) => r.id)];
    expect(ids).toHaveLength(4);
    expect(new Set(ids).size).toBe(4); // no row duplicated across pages
    expect([...ids].sort()).toEqual(seed().map((d) => d._id as string)); // and none lost
    expect(page0.total).toBe(4);
  });

  it('re-reading the same page after a shuffle returns the same rows', async () => {
    const { svc, coll } = buildService(seed());
    const first = await svc.list(PID, { pageIndex: 0, pageSize: 2 }, SCOPE);
    coll.shuffle();
    const again = await svc.list(PID, { pageIndex: 0, pageSize: 2 }, SCOPE);
    expect(again.list.map((r) => r.id)).toEqual(first.list.map((r) => r.id));
  });

  it('listTrash inherits the same total order (it delegates to list)', async () => {
    const { svc, coll } = buildService(seed(true));
    const page0 = await svc.listTrash(PID, 0, 2, undefined, SCOPE);
    expect(coll.sorts[0]).toEqual({ updatedAt: -1, _id: -1 });
    coll.shuffle();
    const page1 = await svc.listTrash(PID, 1, 2, undefined, SCOPE);
    const ids = [...page0.list.map((r) => r.id), ...page1.list.map((r) => r.id)];
    expect(new Set(ids).size).toBe(4);
  });
});
