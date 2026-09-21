/**
 * Delta write paths: orphan projections (TODO-263) and the delete-before-create
 * tombstone race (TODO-485).
 *
 * AS-IS:
 *  - `projectUpsert` inserted `ownerId: null` when the event carried no owner,
 *    producing a record no visibility scope but mode='all' can ever match — while
 *    the service-only `indexUpsert` rejects exactly that shape. Nothing counted or
 *    logged it, so the record just silently vanished from everyone's search.
 *  - `indexDelete` updated WITHOUT `upsert`, so a `deleted` event delivered before
 *    the matching `created` wrote nothing and the later create resurrected the
 *    record.
 */
import { SearchService } from './search.service';
import { buildMongo } from './fake-mongo.testkit';
import type { VisibilityScope } from '@fairflow/shared';

const PID = 'proj-1';
const OWN_SCOPE: VisibilityScope = {
  mode: 'restricted',
  level: 'custom',
  selfId: 'user-1',
  ownerIds: ['user-1'],
  sharedRecordIds: [],
};
const ALL_SCOPE: VisibilityScope = { ...OWN_SCOPE, mode: 'all', ownerIds: [] };

describe('orphan projections are accounted for (TODO-263)', () => {
  it('rejects an insert without an owner and records the orphan metric', async () => {
    const { mongo, state, index } = buildMongo({});
    const svc = new SearchService(mongo as never);
    const warn = jest.spyOn(svc['logger'], 'warn').mockImplementation(() => undefined);

    await svc.projectUpsert({
      projectId: PID,
      entityType: 'deal',
      entityId: 'd1',
      title: 'ownerless',
      sourceUpdatedAt: 10,
      version: 10,
    });

    expect(index.docs).toHaveLength(0);
    expect((state.docs[0] as { orphanProjectionCount?: number }).orphanProjectionCount).toBe(1);
    expect((state.docs[0] as { lastOrphanProjectionAt?: number }).lastOrphanProjectionAt)
      .toBeGreaterThan(0);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('rejected insert without ownerId'));

    const own = await svc.search(PID, 'ownerless', 0, 25, {
      entityTypes: ['deal'],
      ctx: { scope: OWN_SCOPE },
    });
    expect(own.total).toBe(0);
    const all = await svc.search(PID, 'ownerless', 0, 25, {
      entityTypes: ['deal'],
      ctx: { scope: ALL_SCOPE },
    });
    expect(all.total).toBe(0);
  });

  it('allows a product insert without ownerId (project-level catalogue)', async () => {
    const { mongo, index, state } = buildMongo({});
    const svc = new SearchService(mongo as never);

    await svc.projectUpsert({
      projectId: PID,
      entityType: 'product',
      entityId: 'p1',
      title: 'SKU widget',
      departmentId: 'dep-1',
      sourceUpdatedAt: 10,
      version: 10,
    });

    expect(index.docs).toHaveLength(1);
    expect(index.docs[0].ownerId).toBeUndefined();
    expect(
      state.docs.some((d) => (d as { orphanProjectionCount?: number }).orphanProjectionCount),
    ).toBe(false);
  });

  it('does not count an insert WITH an owner, nor an update of an existing doc', async () => {
    const { mongo, state } = buildMongo({});
    const svc = new SearchService(mongo as never);

    await svc.projectUpsert({
      projectId: PID,
      entityType: 'deal',
      entityId: 'd1',
      title: 'owned',
      ownerId: 'user-1',
      sourceUpdatedAt: 10,
      version: 10,
    });
    // Partial follow-up event without owner — merges over an existing doc.
    await svc.projectUpsert({
      projectId: PID,
      entityType: 'deal',
      entityId: 'd1',
      subtitle: 'stage-2',
      sourceUpdatedAt: 20,
      version: 20,
    });

    expect(
      state.docs.some((d) => (d as { orphanProjectionCount?: number }).orphanProjectionCount),
    ).toBe(false);
  });
});

describe('delete-before-create tombstone (TODO-485)', () => {
  it('indexDelete writes a tombstone even when the document does not exist yet', async () => {
    const { mongo, index } = buildMongo({});
    const svc = new SearchService(mongo as never);

    await svc.indexDelete({ projectId: PID, entityType: 'deal', entityId: 'd1', version: 200 });

    expect(index.docs).toHaveLength(1);
    expect(index.docs[0].deletedAt).toEqual(expect.any(Number));
    expect(index.docs[0].version).toBe(200);
    expect(index.docs[0].path).toBe(`/p/${PID}/deals/d1`);
  });

  it('a late, older create does not resurrect the deleted record', async () => {
    const { mongo, index } = buildMongo({});
    const svc = new SearchService(mongo as never);

    // Out-of-order delivery: delete (v200) arrives before create (v100).
    await svc.indexDelete({ projectId: PID, entityType: 'deal', entityId: 'd1', version: 200 });
    await svc.projectUpsert({
      projectId: PID,
      entityType: 'deal',
      entityId: 'd1',
      title: 'zombie',
      tokens: 'zombie',
      ownerId: 'user-1',
      sourceUpdatedAt: 100,
      version: 100,
    });

    expect(index.docs).toHaveLength(1); // no duplicate row (unique key held)
    expect(index.docs[0].deletedAt).toEqual(expect.any(Number));
    const res = await svc.search(PID, 'zombie', 0, 25, {
      entityTypes: ['deal'],
      ctx: { scope: ALL_SCOPE },
    });
    expect(res.total).toBe(0);
  });

  it('a NEWER create after the tombstone still re-creates the record', async () => {
    const { mongo } = buildMongo({});
    const svc = new SearchService(mongo as never);

    await svc.indexDelete({ projectId: PID, entityType: 'deal', entityId: 'd1', version: 100 });
    await svc.projectUpsert({
      projectId: PID,
      entityType: 'deal',
      entityId: 'd1',
      title: 'restored',
      tokens: 'restored',
      ownerId: 'user-1',
      sourceUpdatedAt: 300,
      version: 300,
    });

    const res = await svc.search(PID, 'restored', 0, 25, {
      entityTypes: ['deal'],
      ctx: { scope: ALL_SCOPE },
    });
    expect(res.list.map((h) => h.entity_id)).toEqual(['d1']);
  });
});
