/**
 * T-018: lazy self-heal backfill.
 *
 * The event delta projection only indexes CRM facts emitted AFTER its durable
 * queue was bound; records created earlier (demo seed / pre-existing data) never
 * produced a delivered event, so their project's `search_index` stays empty and
 * search "ничего не находит". `SearchService.search` must, on the FIRST real query
 * against an empty project, rebuild the index once from the source collections
 * (idempotent `reindex`) and stamp `backfilledAt` so the source scan never repeats.
 *
 * These tests wire the REAL SearchService against the in-memory Mongo double from
 * `./fake-mongo.testkit`, whose collections honour the operations the backfill +
 * reindex + read paths use.
 */
import { SearchService } from './search.service';
import type { VisibilityScope } from '@fairflow/shared';
import { buildMongo, row, type Row } from './fake-mongo.testkit';

const PID = 'proj-1';
const OTHER = 'proj-2';

const ALL_SCOPE: VisibilityScope = {
  mode: 'all',
  level: 'custom',
  selfId: 'user-1',
  ownerIds: [],
  sharedRecordIds: [],
};

function srcContact(projectId: string, id: string, firstName: string, ownerId = 'user-1'): Row {
  return row(id, {
    projectId,
    firstName,
    lastName: 'Zeta',
    email: `${firstName}@t018.local`,
    ownerId,
    departmentId: 'dept-1',
  });
}

function srcProduct(projectId: string, id: string, name: string, category = ''): Row {
  return row(id, { projectId, name, category, ownerDepartmentId: null });
}

describe('search lazy backfill (T-018)', () => {
  const OLD_ENV = process.env.SEARCH_LAZY_BACKFILL;
  afterEach(() => {
    if (OLD_ENV === undefined) delete process.env.SEARCH_LAZY_BACKFILL;
    else process.env.SEARCH_LAZY_BACKFILL = OLD_ENV;
  });

  it('backfills an empty project from source collections on the first query', async () => {
    delete process.env.SEARCH_LAZY_BACKFILL;
    const { mongo, index, state } = buildMongo({
      contacts: [
        srcContact(PID, 'c1', 'alphaone'),
        srcContact(OTHER, 'c2', 'alphatwo'), // different project — must NOT leak into PID hits
      ],
    });
    const svc = new SearchService(mongo as never);

    const res = await svc.search(PID, 'alphaone', 0, 25, {
      entityTypes: ['contact'],
      ctx: { scope: ALL_SCOPE },
    });

    // The empty index was rebuilt from the source contact and the hit is returned.
    expect(res.list.map((h) => h.entity_id)).toEqual(['c1']);
    expect(res.total).toBe(1);
    // Backfill was stamped so it never repeats.
    expect((state.docs[0] as { backfilledAt?: number }).backfilledAt).toBeGreaterThan(0);
    // Index only contains PID rows for the query — isolation holds.
    expect(index.docs.every((d) => d.projectId === PID || d.projectId === OTHER)).toBe(true);
    const pidHit = await svc.search(PID, 'alphatwo', 0, 25, {
      entityTypes: ['contact'],
      ctx: { scope: ALL_SCOPE },
    });
    expect(pidHit.total).toBe(0); // other-project contact never visible under PID scope
  });

  it('backfills products from crm_products (TODO-049: recovery path existed for 4 of 6 types)', async () => {
    delete process.env.SEARCH_LAZY_BACKFILL;
    const { mongo, index } = buildMongo({
      products: [
        srcProduct(PID, 'p1', 'Widget Deluxe', 'gadgets'),
        srcProduct(OTHER, 'p2', 'Widget Other'), // different project — must not leak
      ],
    });
    const svc = new SearchService(mongo as never);

    const res = await svc.search(PID, 'widget', 0, 25, {
      entityTypes: ['product'],
      ctx: { scope: ALL_SCOPE },
    });

    expect(res.list.map((h) => h.entity_id)).toEqual(['p1']);
    expect(res.total).toBe(1);
    const doc = index.docs.find((d) => d.entityType === 'product' && d.entityId === 'p1');
    expect(doc?.title).toBe('Widget Deluxe');
    expect(doc?.subtitle).toBe('gadgets');
    expect(doc?.path).toBe(`/p/${PID}/products/p1`);
  });

  it('does not re-run the source scan once backfilledAt is stamped', async () => {
    delete process.env.SEARCH_LAZY_BACKFILL;
    const { mongo, contacts } = buildMongo({
      state: [{ _id: { toString: () => 's' }, projectId: PID, backfilledAt: 111 }],
      contacts: [srcContact(PID, 'c1', 'alphaone')],
    });
    const svc = new SearchService(mongo as never);
    const spy = jest.spyOn(contacts, 'find');

    const res = await svc.search(PID, 'alphaone', 0, 25, {
      entityTypes: ['contact'],
      ctx: { scope: ALL_SCOPE },
    });

    expect(res.total).toBe(0); // index empty & backfill skipped → no hit
    expect(spy).not.toHaveBeenCalled(); // source collections never scanned again
  });

  it('is disabled by SEARCH_LAZY_BACKFILL=false', async () => {
    process.env.SEARCH_LAZY_BACKFILL = 'false';
    const { mongo, contacts } = buildMongo({ contacts: [srcContact(PID, 'c1', 'alphaone')] });
    const svc = new SearchService(mongo as never);
    const spy = jest.spyOn(contacts, 'find');

    const res = await svc.search(PID, 'alphaone', 0, 25, {
      entityTypes: ['contact'],
      ctx: { scope: ALL_SCOPE },
    });

    expect(res.total).toBe(0);
    expect(spy).not.toHaveBeenCalled();
  });

  it('skips the backfill when the index already has rows (delta path is live)', async () => {
    delete process.env.SEARCH_LAZY_BACKFILL;
    const now = Date.now();
    const existing: Row = {
      _id: { toString: () => 'contact:c9' },
      projectId: PID,
      entityType: 'contact',
      entityId: 'c9',
      title: 'alphaone Zeta',
      subtitle: '',
      tokens: 'alphaone zeta',
      ownerId: 'user-1',
      departmentId: null,
      deletedAt: null,
      version: now,
      updatedAt: now,
    };
    const { mongo, contacts, state } = buildMongo({ index: [existing], contacts: [srcContact(PID, 'c1', 'alphaone')] });
    const svc = new SearchService(mongo as never);
    const spy = jest.spyOn(contacts, 'find');

    const res = await svc.search(PID, 'alphaone', 0, 25, {
      entityTypes: ['contact'],
      ctx: { scope: ALL_SCOPE },
    });

    expect(res.list.map((h) => h.entity_id)).toEqual(['c9']); // pre-existing delta row
    expect(spy).not.toHaveBeenCalled(); // no source scan — index was non-empty
    expect((state.docs[0] as { backfilledAt?: number }).backfilledAt).toBeGreaterThan(0); // stamped to short-circuit next time
  });
});
