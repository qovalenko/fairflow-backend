/**
 * ABAC attributes materialized as FLAT index fields (TODO-483).
 *
 * AS-IS: `abacAttrs` was written only for deals (`{ stageId }`) and only NESTED,
 * while `compileMongo` emits conditions over FLAT top-level fields
 * (`record.<attr>` → `{ <attr>: {...} }`, shared/src/abac/materialize.ts). Any
 * ABAC-narrowed search therefore matched nothing — the predicate looked at a path
 * the index document did not have, for every type including deals.
 */
import { SearchService } from './search.service';
import { ProjectionApply, type ProjectionDoc } from './search-projection.apply';
import { pickAbacFields, searchAbacIndexSpecs } from './abac-fields';
import { buildMongo, row } from './fake-mongo.testkit';
import type { VisibilityScope } from '@fairflow/shared';

const PID = 'proj-1';
const ALL_SCOPE: VisibilityScope = {
  mode: 'all',
  level: 'custom',
  selfId: 'user-1',
  ownerIds: [],
  sharedRecordIds: [],
};

describe('pickAbacFields', () => {
  it('keeps only the attributes the shared manifest declares for the type', () => {
    expect(
      pickAbacFields('deal', { amount: 100, stageId: 's1', secretNote: 'x', title: 'hack' }),
    ).toEqual({ amount: 100, stageId: 's1' });
  });

  it('materializes attributes for non-deal types too', () => {
    expect(pickAbacFields('contact', { source: 'ads', tags: ['vip'] })).toEqual({
      source: 'ads',
      tags: ['vip'],
    });
    expect(pickAbacFields('activity', { type: 'call', status: 'planned' })).toEqual({
      type: 'call',
      status: 'planned',
    });
    expect(pickAbacFields('company', { region: 'msk' })).toEqual({ region: 'msk' });
  });

  it('never shadows an index document field', () => {
    expect(searchAbacIndexSpecs().map((s) => s.name)).not.toContain('abac_projectId_title');
  });
});

describe('reindex materializes flat ABAC fields (TODO-483)', () => {
  it('writes the attributes flat AND keeps a debug copy in abacAttrs', async () => {
    const { mongo, index } = buildMongo({
      deals: [
        row('d1', {
          projectId: PID,
          name: 'Big deal',
          stageId: 'stage-1',
          amount: 500,
          ownerId: 'user-1',
        }),
      ],
    });
    const svc = new SearchService(mongo as never);

    await svc.reindex(PID, ['deal']);

    const doc = index.docs[0];
    expect(doc.stageId).toBe('stage-1');
    expect(doc.amount).toBe(500);
    // [review-1] The reindex reads the WHOLE source row, so it is authoritative
    // about absence too: an attribute the deal has no value for is materialized as
    // an explicit `null`, not left off. That is what lets the read tell "the record
    // is empty here" (null, judged by the predicate) from "this document never
    // learned the attribute" (field absent, dropped) — see abacCompletenessFilter.
    expect(doc.abacAttrs).toEqual({
      amount: 500,
      stageId: 'stage-1',
      status: null,
      pipelineId: null,
      source: null,
      probability: null,
      expectedCloseDate: null,
      tags: null,
    });
  });

  it('a compiled predicate over a flat attribute actually narrows the read', async () => {
    const { mongo } = buildMongo({
      deals: [
        row('d1', { projectId: PID, name: 'alpha small', amount: 500, ownerId: 'user-1' }),
        row('d2', { projectId: PID, name: 'alpha big', amount: 5_000_000, ownerId: 'user-1' }),
      ],
    });
    const svc = new SearchService(mongo as never);

    const narrowed = await svc.search(PID, 'alpha', 0, 25, {
      entityTypes: ['deal'],
      ctx: { scope: ALL_SCOPE, accessPredicate: { amount: { $lt: 1_000_000 } } },
    });
    expect(narrowed.list.map((h) => h.entity_id)).toEqual(['d1']);

    const wide = await svc.search(PID, 'alpha', 0, 25, {
      entityTypes: ['deal'],
      ctx: { scope: ALL_SCOPE },
    });
    expect(wide.total).toBe(2);
  });
});

describe('event delta materializes flat ABAC fields (TODO-483)', () => {
  it('every type ships abacFields, and a partial stage_changed refreshes stageId', async () => {
    const writes: ProjectionDoc[] = [];
    const apply = new ProjectionApply({
      upsert: async (d) => {
        writes.push(d);
      },
      tombstone: async () => undefined,
    });

    await apply.apply('crm.contact.created', PID, {
      payload: { contactId: 'c1', firstName: 'Ivan', source: 'ads', ownerId: 'u1', updatedAt: 1 },
      timestamp: new Date(1).toISOString(),
    });
    await apply.apply('crm.deal.stage_changed', PID, {
      payload: { dealId: 'd1', toStageId: 'stage-2', ownerId: 'u1', updatedAt: 2 },
      timestamp: new Date(2).toISOString(),
    });

    expect(writes[0].abacFields).toEqual({ source: 'ads' });
    expect(writes[1].abacFields).toEqual({ stageId: 'stage-2' });
  });

  it('projectUpsert persists abacFields as real document fields', async () => {
    const { mongo, index } = buildMongo({});
    const svc = new SearchService(mongo as never);

    await svc.projectUpsert({
      projectId: PID,
      entityType: 'deal',
      entityId: 'd1',
      title: 'alpha',
      tokens: 'alpha',
      ownerId: 'user-1',
      abacFields: { stageId: 'stage-2', amount: 42 },
      abacAttrs: { stageId: 'stage-2', amount: 42 },
      sourceUpdatedAt: 10,
      version: 10,
    });

    expect(index.docs[0].stageId).toBe('stage-2');
    expect(index.docs[0].amount).toBe(42);

    const hit = await svc.search(PID, 'alpha', 0, 25, {
      entityTypes: ['deal'],
      ctx: { scope: ALL_SCOPE, accessPredicate: { stageId: 'stage-2' } },
    });
    expect(hit.list.map((h) => h.entity_id)).toEqual(['d1']);
  });
});

describe('index bootstrap (TODO-483)', () => {
  it('creates the project-scoped compound index for every materialized attribute', async () => {
    const { mongo, index } = buildMongo({});
    const svc = new SearchService(mongo as never);

    await svc.onModuleInit();

    const names = index.createdIndexes.map((i) => JSON.stringify(i.key));
    expect(names).toContain(JSON.stringify({ projectId: 1, entityType: 1, entityId: 1 }));
    expect(names).toContain(
      JSON.stringify({ projectId: 1, entityType: 1, deletedAt: 1, updatedAt: -1 }),
    );
    for (const spec of searchAbacIndexSpecs()) {
      expect(names).toContain(JSON.stringify(spec.key));
      // Isolation always wins the index prefix (non-negotiable №3).
      expect(Object.keys(spec.key)[0]).toBe('projectId');
    }
  });
});
