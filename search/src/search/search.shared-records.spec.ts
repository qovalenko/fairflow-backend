/**
 * TODO-109: a record explicitly SHARED with the viewer must be findable in global
 * search, exactly as it is on its own module's list route.
 *
 * AS-IS the domain ANDed `buildVisibilityFilter(scope,'ownerId',scope.sharedRecordIds)`,
 * whose share disjunct is `_id ∈ sharedIds` — the search index `_id` is the index
 * row id, not the source record id, so the disjunct could not match and shared
 * records were invisible in search forever (and `sharedRecordIds` was empty anyway:
 * the gateway resolves shares per resource, and the cross-entity /search route has
 * none). The scope now carries `sharedRecordIdsByType` and the domain matches
 * `(entityType, entityId)`.
 *
 * The real SearchService runs against the in-memory index, so the assertions are on
 * the Mongo predicate the PEP actually builds.
 */
import type { VisibilityScope } from '@fairflow/shared';
import { SearchService } from './search.service';
import { buildMongo } from './fake-mongo.testkit';

const PID = 'proj-1';

const OWN_SCOPE: VisibilityScope = {
  mode: 'restricted',
  level: 'custom',
  selfId: 'user-1',
  ownerIds: ['user-1'],
  sharedRecordIds: [],
};

/** Seed: one own contact, one foreign contact, one foreign deal — all matching "acme". */
async function seed(svc: SearchService) {
  await svc.projectUpsert({
    projectId: PID,
    entityType: 'contact',
    entityId: 'c-own',
    title: 'Acme own contact',
    ownerId: 'user-1',
    sourceUpdatedAt: 10,
    version: 10,
  });
  await svc.projectUpsert({
    projectId: PID,
    entityType: 'contact',
    entityId: 'c-shared',
    title: 'Acme shared contact',
    ownerId: 'user-2',
    sourceUpdatedAt: 10,
    version: 10,
  });
  await svc.projectUpsert({
    projectId: PID,
    entityType: 'deal',
    entityId: 'c-shared',
    title: 'Acme foreign deal',
    ownerId: 'user-2',
    sourceUpdatedAt: 10,
    version: 10,
  });
}

const found = (res: { groups: Array<{ list: Array<{ entity_type: string; entity_id: string }> }> }) =>
  res.groups
    .flatMap((g) => g.list)
    .map((h) => `${h.entity_type}:${h.entity_id}`)
    .sort();

describe('shared records in global search (TODO-109)', () => {
  it('without a share map only own records are found', async () => {
    const { mongo } = buildMongo({});
    const svc = new SearchService(mongo as never);
    await seed(svc);

    const res = await svc.search(PID, 'acme', 0, 25, { ctx: { scope: OWN_SCOPE } });
    expect(res.total).toBe(1);
    expect(found(res)).toEqual(['contact:c-own']);
  });

  it('a contact shared with the viewer becomes findable — and ONLY that entity type', async () => {
    const { mongo } = buildMongo({});
    const svc = new SearchService(mongo as never);
    await seed(svc);

    const scope: VisibilityScope = {
      ...OWN_SCOPE,
      sharedRecordIdsByType: { contact: ['c-shared'] },
    };
    const res = await svc.search(PID, 'acme', 0, 25, { ctx: { scope } });

    // The deal carries the SAME entityId — a share of the contact must not leak it.
    expect(found(res)).toEqual(['contact:c-own', 'contact:c-shared']);
    expect(res.total).toBe(2);
    expect(res.total_by_type).toEqual({ contact: 2 });
  });

  it('a share never resurrects a deleted record', async () => {
    const { mongo } = buildMongo({});
    const svc = new SearchService(mongo as never);
    await seed(svc);
    await svc.indexDelete({
      projectId: PID,
      entityType: 'contact',
      entityId: 'c-shared',
      version: 11,
    });

    const scope: VisibilityScope = {
      ...OWN_SCOPE,
      sharedRecordIdsByType: { contact: ['c-shared'] },
    };
    const res = await svc.search(PID, 'acme', 0, 25, { ctx: { scope } });
    expect(found(res)).toEqual(['contact:c-own']);
  });

  it('a share does not bypass the enabled-modules type gate (FR-MSRCH-11)', async () => {
    const { mongo } = buildMongo({});
    const svc = new SearchService(mongo as never);
    await seed(svc);

    const scope: VisibilityScope = {
      ...OWN_SCOPE,
      ownerIds: [],
      sharedRecordIdsByType: { deal: ['c-shared'] },
    };
    const res = await svc.search(PID, 'acme', 0, 25, {
      ctx: { scope, enabledModules: ['contacts'] },
    });
    expect(res.total).toBe(0);
  });

  it('fail-closed is untouched: no scope → nothing, even with shares seeded', async () => {
    const { mongo } = buildMongo({});
    const svc = new SearchService(mongo as never);
    await seed(svc);

    const res = await svc.search(PID, 'acme', 0, 25, { ctx: {} });
    expect(res.total).toBe(0);
    expect(found(res)).toEqual([]);
  });
});
