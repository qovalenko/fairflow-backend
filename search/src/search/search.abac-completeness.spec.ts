/**
 * [review-1] The seam between the TWO write paths of the search index and the ABAC
 * predicate the read applies to whatever they left behind.
 *
 * AS-IS defect: `buildProjection` materializes the declared ABAC attributes out of
 * the EVENT payload, and the producers ship a hand-picked field list
 * (`crm.company.created` = name/ownerId/source — no `industry`, no `region`), while
 * `reindex()` materializes them out of the full source row. The very same record was
 * therefore ABAC-attribute-less when it entered the index through an event and
 * ABAC-complete after a Reindex. For an allow-condition that is "only" an
 * availability gap (missing field never matches `{region:'EU'}`, so the record
 * disappears from search while staying visible on its own list route); for the DENY
 * form the gateway emits — `{$nor: [{region:'EU'}]}` — a missing field MATCHES, so a
 * record a deny-rule forbids leaks through search with its title/subtitle/entity_id.
 *
 * TO-BE: the reindex path is authoritative (absent value → explicit `null`), the
 * event path stays honest about what it heard, and the read only judges a document
 * on attributes it actually carries (`abacCompletenessFilter`).
 */
import type { VisibilityScope } from '@fairflow/shared';
import { SearchService } from './search.service';
import { ProjectionApply, type ProjectionDoc } from './search-projection.apply';
import { abacCompletenessFilter, pickAbacFields } from './abac-fields';
import { buildMongo, row } from './fake-mongo.testkit';

const PID = 'proj-1';
const ALL_SCOPE: VisibilityScope = {
  mode: 'all',
  level: 'custom',
  selfId: 'user-1',
  ownerIds: [],
  sharedRecordIds: [],
};

// «Всё, кроме EU» as the gateway compiles a conditional DENY rule (access-predicate.ts:197).
const DENY_REGION_EU = {
  $or: [
    { $and: [{ entityType: 'company' }, { $nor: [{ region: 'EU' }] }] },
    { entityType: 'contact' },
  ],
};

describe('abacCompletenessFilter (read-side guard)', () => {
  it('is a no-op without a predicate and for predicates over own index fields', () => {
    expect(abacCompletenessFilter(['deal'], undefined)).toBeNull();
    expect(abacCompletenessFilter(['deal'], {})).toBeNull();
    // subtitle/ownerId are written by BOTH paths → always known, nothing to guard.
    expect(abacCompletenessFilter(['deal'], { subtitle: { $eq: 'gold' } })).toBeNull();
  });

  it('requires the attribute only of the type the predicate constrains', () => {
    expect(abacCompletenessFilter(['company', 'contact'], DENY_REGION_EU)).toEqual({
      $or: [
        { entityType: { $in: ['contact'] } },
        { $and: [{ entityType: 'company' }, { region: { $exists: true } }] },
      ],
    });
  });

  it('drops a type whose rule references an attribute the index cannot materialize', () => {
    // `assigneeId` is not a declared ABAC attribute and is not an index field:
    // search cannot honour the rule for deals, so deals are dropped (fail-closed,
    // the same "undecidable ⇒ drop the subject" rule the gateway compiles by).
    expect(abacCompletenessFilter(['deal', 'contact'], { $or: [
      { $and: [{ entityType: 'deal' }, { assigneeId: 'u9' }] },
      { entityType: 'contact' },
    ] })).toEqual({ entityType: { $in: ['contact'] } });
    // Every type dropped → match nothing, without an empty `$or` (Mongo rejects it).
    expect(abacCompletenessFilter(['deal'], { assigneeId: 'u9' })).toEqual({
      entityType: { $in: [] },
    });
  });
});

describe('pickAbacFields: only an authoritative snapshot may claim absence', () => {
  it('event payload → attributes it did not carry stay ABSENT', () => {
    expect(pickAbacFields('company', { companyId: 'c1', name: 'Acme', source: 'ads' })).toEqual({});
  });

  it('full source row → absent attribute is materialized as an explicit null', () => {
    expect(pickAbacFields('company', { name: 'Acme', region: 'RU' }, { complete: true })).toEqual({
      industry: null,
      region: 'RU',
      tags: null,
    });
  });

  it('reads the snake_case spelling the source collections carry', () => {
    expect(pickAbacFields('deal', { stage_id: 's1', amount: 10 }, { complete: true })).toMatchObject({
      stageId: 's1',
      amount: 10,
    });
  });
});

describe('event-projected document vs a predicate over an attribute it never learned', () => {
  /** Index a company exactly as the delta consumer does: event payload → projection. */
  async function indexByEvent(svc: SearchService, id: string, payload: Record<string, unknown>) {
    const apply = new ProjectionApply({
      upsert: async (d: ProjectionDoc) => {
        await svc.projectUpsert(d);
      },
      tombstone: async () => undefined,
    });
    await apply.apply('crm.company.created', PID, {
      payload: { companyId: id, ...payload },
      timestamp: new Date(10).toISOString(),
    });
  }

  it('is NOT handed out by a deny-rule it cannot be judged against, and Reindex fixes it', async () => {
    // The source row the producer never puts in the payload: this company IS in EU.
    const { mongo, index } = buildMongo({
      companies: [row('eu1', { projectId: PID, name: 'Alpha EU', region: 'EU', ownerId: 'user-1' })],
    });
    const svc = new SearchService(mongo as never);
    await indexByEvent(svc, 'eu1', { name: 'Alpha EU', ownerId: 'user-1', updatedAt: 10 });

    // The event path is honest: no `region` on the document at all.
    expect('region' in index.docs[0]).toBe(false);

    const denied = await svc.search(PID, 'alpha', 0, 25, {
      entityTypes: ['company'],
      ctx: { scope: ALL_SCOPE, accessPredicate: DENY_REGION_EU },
    });
    // AS-IS this returned the EU company: `$nor:[{region:'EU'}]` matches a document
    // with no `region`, so the deny-rule was bypassed through the search box.
    expect(denied.list).toEqual([]);
    expect(denied.total).toBe(0);
    expect(JSON.stringify(denied)).not.toContain('Alpha EU');

    // Without a predicate the record is searchable as before — the guard narrows
    // the ABAC-filtered read only, it does not hide the record from everybody.
    const wide = await svc.search(PID, 'alpha', 0, 25, {
      entityTypes: ['company'],
      ctx: { scope: ALL_SCOPE },
    });
    expect(wide.total).toBe(1);

    // After the recovery reindex the attribute is real and the deny-rule is
    // enforced on its value (still hidden — the company really is in EU).
    await svc.reindex(PID, ['company']);
    expect(index.docs[0].region).toBe('EU');
    const afterReindex = await svc.search(PID, 'alpha', 0, 25, {
      entityTypes: ['company'],
      ctx: { scope: ALL_SCOPE, accessPredicate: DENY_REGION_EU },
    });
    expect(afterReindex.total).toBe(0);
  });

  it('a reindexed record with no value for the attribute stays searchable under a deny-rule', async () => {
    // The availability half of the same seam: `region` is genuinely empty, and the
    // authoritative rebuild says so with an explicit null — the record is NOT in EU,
    // so the deny-rule must not touch it (this is what makes the guard a narrowing
    // of unknowns, not a blanket "hide everything the ABAC rule mentions").
    const { mongo, index } = buildMongo({
      companies: [row('ru1', { projectId: PID, name: 'Alpha RU', ownerId: 'user-1' })],
    });
    const svc = new SearchService(mongo as never);
    await svc.reindex(PID, ['company']);

    expect('region' in index.docs[0]).toBe(true);
    expect(index.docs[0].region).toBeNull();

    const res = await svc.search(PID, 'alpha', 0, 25, {
      entityTypes: ['company'],
      ctx: { scope: ALL_SCOPE, accessPredicate: DENY_REGION_EU },
    });
    expect(res.list.map((h) => h.entity_id)).toEqual(['ru1']);
  });

  it('the operator recovery RPC materializes the attributes flat too', async () => {
    // Third write path (contract §3.5 IndexUpsert): it used to store the ABAC
    // attributes ONLY nested under `abacAttrs`, which the flat compiled predicate
    // can never match — the same drift TODO-483 closed for the other two paths.
    const { mongo, index } = buildMongo({});
    const svc = new SearchService(mongo as never);
    await svc.indexUpsert({
      projectId: PID,
      entityType: 'company',
      entityId: 'eu2',
      title: 'Alpha recovered',
      tokens: 'alpha recovered',
      ownerId: 'user-1',
      departmentId: 'dep-1',
      abacAttrs: { region: 'EU' },
      version: 10,
    });
    expect(index.docs[0].region).toBe('EU');

    const denied = await svc.search(PID, 'alpha', 0, 25, {
      entityTypes: ['company'],
      ctx: { scope: ALL_SCOPE, accessPredicate: DENY_REGION_EU },
    });
    expect(denied.total).toBe(0);
  });

  it('an attribute the event DID carry is still judged normally (no availability cliff)', async () => {
    // `crm.deal.created` does carry `amount`, so the flagship rule "сделки до
    // миллиона" keeps working on event-only documents.
    const { mongo } = buildMongo({});
    const svc = new SearchService(mongo as never);
    const apply = new ProjectionApply({
      upsert: async (d: ProjectionDoc) => {
        await svc.projectUpsert(d);
      },
      tombstone: async () => undefined,
    });
    for (const [id, amount] of [
      ['small', 10],
      ['big', 5_000_000],
    ] as const) {
      await apply.apply('crm.deal.created', PID, {
        payload: { dealId: id, name: `alpha ${id}`, amount, ownerId: 'user-1', updatedAt: 10 },
        timestamp: new Date(10).toISOString(),
      });
    }

    const res = await svc.search(PID, 'alpha', 0, 25, {
      entityTypes: ['deal'],
      ctx: {
        scope: ALL_SCOPE,
        accessPredicate: { $and: [{ entityType: 'deal' }, { $nor: [{ amount: { $gt: 1_000_000 } }] }] },
      },
    });
    expect(res.list.map((h) => h.entity_id)).toEqual(['small']);
  });
});
