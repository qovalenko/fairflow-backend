/**
 * Recovery reindex — streaming, truncation honesty, tombstones (TODO-256/257)
 * and the activity source that used to be missing entirely (TODO-487, partial).
 *
 * AS-IS defects pinned here:
 *  - every source was read with `.limit(10000).toArray()`: a bigger project
 *    silently lost the tail, and the caller had no way to learn about it;
 *  - the lazy backfill stamped `backfilledAt` after such a partial pass, so the
 *    project could NEVER be filled again;
 *  - the source filter was `{ projectId }` only, so soft-deleted records were
 *    indexed and `$set: { deletedAt: null }` even cleared their tombstone —
 *    deleted records came back in search results;
 *  - records that disappeared from the source stayed searchable forever;
 *  - `activity` was never rebuilt although it is an indexable type.
 */
import { ALL_INDEXABLE_TYPES, SearchService } from './search.service';
import type { VisibilityScope } from '@fairflow/shared';
import { buildMongo, row, type Row } from './fake-mongo.testkit';

const PID = 'proj-1';

const ALL_SCOPE: VisibilityScope = {
  mode: 'all',
  level: 'custom',
  selfId: 'user-1',
  ownerIds: [],
  sharedRecordIds: [],
};

function contact(id: string, firstName: string, extra: Record<string, unknown> = {}): Row {
  return row(id, {
    projectId: PID,
    firstName,
    lastName: 'Zeta',
    ownerId: 'user-1',
    departmentId: 'dept-1',
    ...extra,
  });
}

describe('reindex streaming + truncation (TODO-256)', () => {
  const OLD_MAX = process.env.SEARCH_REINDEX_MAX_DOCS;
  const OLD_BATCH = process.env.SEARCH_REINDEX_BATCH;
  const OLD_RETRY = process.env.SEARCH_BACKFILL_RETRY_MS;
  afterEach(() => {
    if (OLD_MAX === undefined) delete process.env.SEARCH_REINDEX_MAX_DOCS;
    else process.env.SEARCH_REINDEX_MAX_DOCS = OLD_MAX;
    if (OLD_BATCH === undefined) delete process.env.SEARCH_REINDEX_BATCH;
    else process.env.SEARCH_REINDEX_BATCH = OLD_BATCH;
    if (OLD_RETRY === undefined) delete process.env.SEARCH_BACKFILL_RETRY_MS;
    else process.env.SEARCH_BACKFILL_RETRY_MS = OLD_RETRY;
  });

  it('indexes EVERY source row in batches — no hidden 10000 cap', async () => {
    delete process.env.SEARCH_REINDEX_MAX_DOCS;
    process.env.SEARCH_REINDEX_BATCH = '7'; // force several bulkWrite flushes
    const contacts = Array.from({ length: 25 }, (_, i) => contact(`c${i}`, `person${i}`));
    const { mongo, index } = buildMongo({ contacts });
    const svc = new SearchService(mongo as never);

    const res = await svc.reindex(PID, ['contact']);

    expect(res.indexed_count).toBe(25);
    expect(res.truncated).toBe(false);
    expect(res.skipped_types).toEqual([]);
    expect(index.docs.filter((d) => d.entityType === 'contact')).toHaveLength(25);
  });

  it('reports a cut-off pass as truncated + skipped_types instead of lying', async () => {
    process.env.SEARCH_REINDEX_MAX_DOCS = '3';
    delete process.env.SEARCH_REINDEX_BATCH;
    const contacts = Array.from({ length: 10 }, (_, i) => contact(`c${i}`, `person${i}`));
    const { mongo, index } = buildMongo({ contacts });
    const svc = new SearchService(mongo as never);

    const res = await svc.reindex(PID, ['contact']);

    expect(res.indexed_count).toBe(3);
    expect(res.truncated).toBe(true);
    expect(res.skipped_types).toEqual(['contact']);
    expect(index.docs).toHaveLength(3);
  });

  it('lazy backfill does NOT stamp backfilledAt after a truncated pass', async () => {
    process.env.SEARCH_REINDEX_MAX_DOCS = '1';
    delete process.env.SEARCH_LAZY_BACKFILL;
    // The catch-up back-off (TODO-491) is what this test would otherwise trip on:
    // it deliberately retries the backfill on the very next query. Its own
    // behaviour is covered in search.reindex-lock.spec.ts.
    process.env.SEARCH_BACKFILL_RETRY_MS = '0';
    const contacts = [contact('c1', 'alphaone'), contact('c2', 'alphatwo')];
    const { mongo, state } = buildMongo({ contacts });
    const svc = new SearchService(mongo as never);

    await svc.search(PID, 'alpha', 0, 25, { entityTypes: ['contact'], ctx: { scope: ALL_SCOPE } });

    expect(state.docs.some((d) => (d as { backfilledAt?: number }).backfilledAt)).toBe(false);

    // Budget lifted → the next query completes the rebuild and stamps it.
    delete process.env.SEARCH_REINDEX_MAX_DOCS;
    const res = await svc.search(PID, 'alpha', 0, 25, {
      entityTypes: ['contact'],
      ctx: { scope: ALL_SCOPE },
    });
    expect(res.total).toBe(2);
    expect((state.docs[0] as { backfilledAt?: number }).backfilledAt).toBeGreaterThan(0);
  });

  it('a truncated type is NOT swept — the rows it did index survive', async () => {
    process.env.SEARCH_REINDEX_MAX_DOCS = '1';
    const contacts = [contact('c1', 'alphaone'), contact('c2', 'alphatwo')];
    const { mongo, index } = buildMongo({ contacts });
    const svc = new SearchService(mongo as never);

    await svc.reindex(PID, ['contact']);

    expect(index.docs).toHaveLength(1);
    expect(index.docs[0].deletedAt).toBeNull();
  });
});

describe('reindex and soft-deleted / vanished source rows (TODO-257)', () => {
  it('never indexes a soft-deleted source row (Date or epoch marker)', async () => {
    const { mongo, index } = buildMongo({
      contacts: [
        contact('c-live', 'alphalive'),
        contact('c-date', 'alphadate', { deletedAt: new Date() }),
      ],
      orders: [
        row('o-live', { projectId: PID, number: 'ORD-1', ownerId: 'user-1', deletedAt: 0 }),
        row('o-del', { projectId: PID, number: 'ORD-2', ownerId: 'user-1', deletedAt: 1723000000000 }),
      ],
    });
    const svc = new SearchService(mongo as never);

    await svc.reindex(PID, ['contact', 'order']);

    expect(index.docs.map((d) => d.entityId).sort()).toEqual(['c-live', 'o-live']);
  });

  it('does not resurrect a tombstoned index doc whose source row is soft-deleted', async () => {
    const now = Date.now();
    const tombstoned = row('contact:c1', {
      projectId: PID,
      entityType: 'contact',
      entityId: 'c1',
      title: 'alphaone Zeta',
      tokens: 'alphaone zeta',
      ownerId: 'user-1',
      deletedAt: now - 1000,
      version: now - 1000,
      updatedAt: now - 1000,
    });
    const { mongo, index } = buildMongo({
      index: [tombstoned],
      contacts: [contact('c1', 'alphaone', { deletedAt: new Date() })],
    });
    const svc = new SearchService(mongo as never);

    await svc.reindex(PID, ['contact']);

    expect(index.docs[0].deletedAt).not.toBeNull();
  });

  it('tombstones index docs the source no longer contains (complete pass only)', async () => {
    const old = Date.now() - 10_000;
    const stale = row('contact:gone', {
      projectId: PID,
      entityType: 'contact',
      entityId: 'gone',
      title: 'ghost record',
      tokens: 'ghost record',
      ownerId: 'user-1',
      deletedAt: null,
      version: old,
      updatedAt: old,
    });
    const untouchedType = row('deal:d1', {
      projectId: PID,
      entityType: 'deal',
      entityId: 'd1',
      title: 'deal one',
      tokens: 'deal one',
      ownerId: 'user-1',
      deletedAt: null,
      version: old,
      updatedAt: old,
    });
    const { mongo, index } = buildMongo({
      index: [stale, untouchedType],
      contacts: [contact('c1', 'alphaone')],
    });
    const svc = new SearchService(mongo as never);

    // Partial reindex of contacts only.
    await svc.reindex(PID, ['contact']);

    const ghost = index.docs.find((d) => d.entityId === 'gone');
    expect(ghost?.deletedAt).toEqual(expect.any(Number));
    // A type this pass did not read must never be swept.
    expect(index.docs.find((d) => d.entityId === 'd1')?.deletedAt).toBeNull();
    // The live source row is indexed and searchable.
    expect(index.docs.find((d) => d.entityId === 'c1')?.deletedAt).toBeNull();
  });

  it('a restored source row clears its stale tombstone', async () => {
    const old = Date.now() - 10_000;
    const { mongo, index } = buildMongo({
      index: [
        row('contact:c1', {
          projectId: PID,
          entityType: 'contact',
          entityId: 'c1',
          title: 'alphaone Zeta',
          ownerId: 'user-1',
          deletedAt: old,
          version: old,
          updatedAt: old,
        }),
      ],
      contacts: [contact('c1', 'alphaone')],
    });
    const svc = new SearchService(mongo as never);

    await svc.reindex(PID, ['contact']);

    expect(index.docs[0].deletedAt).toBeNull();
  });
});

describe('reindex covers the activity source (TODO-487, partial)', () => {
  it('rebuilds activities so a backfilled project can find them', async () => {
    const { mongo, index } = buildMongo({
      activities: [
        row('a1', {
          projectId: PID,
          title: 'Позвонить клиенту',
          type: 'call',
          status: 'planned',
          assigneeId: 'user-1',
          deletedAt: null,
        }),
        row('a2', {
          projectId: PID,
          title: 'Удалённая задача',
          type: 'task',
          status: 'planned',
          assigneeId: 'user-1',
          deletedAt: new Date(),
        }),
      ],
    });
    const svc = new SearchService(mongo as never);

    const res = await svc.reindex(PID);

    expect(res.sources).toContain('crm_activities');
    const doc = index.docs.find((d) => d.entityType === 'activity');
    expect(doc?.entityId).toBe('a1');
    expect(doc?.path).toBe(`/p/${PID}/activities/a1`);
    expect(doc?.ownerId).toBe('user-1'); // assigneeId → index ownerId
    // The soft-deleted activity is not indexed.
    expect(index.docs.filter((d) => d.entityType === 'activity')).toHaveLength(1);

    const hit = await svc.search(PID, 'позвонить', 0, 25, {
      entityTypes: ['activity'],
      ctx: { scope: ALL_SCOPE },
    });
    expect(hit.list.map((h) => h.entity_id)).toEqual(['a1']);
  });
});

describe('reindex source coverage is complete (TODO-487 regression guard)', () => {
  it('rebuilds EVERY indexable type — a type without a source cannot slip through', async () => {
    const { mongo, index } = buildMongo({
      contacts: [contact('c1', 'Иван')],
      companies: [row('co1', { projectId: PID, name: 'Ромашка', ownerId: 'user-1', deletedAt: null })],
      deals: [row('d1', { projectId: PID, name: 'Сделка', ownerId: 'user-1', deletedAt: null })],
      orders: [row('o1', { projectId: PID, number: 'ORD-1', ownerId: 'user-1', deletedAt: null })],
      products: [row('p1', { projectId: PID, name: 'Товар', deletedAt: null })],
      activities: [row('a1', { projectId: PID, title: 'Звонок', assigneeId: 'user-1', deletedAt: null })],
    });
    const svc = new SearchService(mongo as never);

    const res = await svc.reindex(PID);

    // One source collection per indexable type. `activity` went missing exactly
    // this way — indexable (ALL_INDEXABLE_TYPES, hence offerable by the module
    // gate) and maintained by the delta consumer, but never rebuilt — so a
    // project that only ever got the lazy backfill could not find a single
    // activity. Adding a 7th type without a source now fails here.
    expect(res.sources).toHaveLength(ALL_INDEXABLE_TYPES.length);
    expect(new Set(index.docs.map((d) => d.entityType))).toEqual(new Set(ALL_INDEXABLE_TYPES));
  });
});
