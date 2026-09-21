/**
 * TODO-264 / TODO-265 — the two event shapes the search projection understood
 * NOTHING of, so the index silently diverged from the CRM:
 *
 *  - TODO-264 `*.updated` is a DIFF and every producer spells it differently:
 *    contact ships `changes: [{field, oldValue, newValue}]`
 *    (contacts.service.ts:389), company ships `changedFields: [{field, old, new}]`
 *    (companies.service.ts:491), product ships `changes: [{field, old, new}]`.
 *    Only the last spelling was read, so renaming a contact/company never reached
 *    the index. Reading the diff alone is not enough either: a composite title
 *    (`firstName lastName`) rebuilt from a one-field diff would DROP the other
 *    half, so the diff is merged over the projection inputs stored on the doc.
 *
 *  - TODO-265 `*.merged` / `*.merge_reverted` name the participants by role
 *    (`sourceContactIds`/`targetContactId`, `masterId`/`loserId`), which `pickId`
 *    never recognised → 'unmapped', ack'ed, nothing written. The absorbed record
 *    stayed findable forever as a duplicate of its survivor.
 *
 * Payload shapes below are copied from the producing domains verbatim.
 */
import {
  ProjectionApply,
  type ProjectionDoc,
  type SearchDeltaWriter,
} from './search-projection.apply';

const PID = 'proj-1';
const TS = '2026-08-16T10:00:00.000Z';

class FakeWriter implements SearchDeltaWriter {
  upserts: ProjectionDoc[] = [];
  tombstones: Array<{ entityType: string; entityId: string; version: number }> = [];
  /** `null` = the record has no index doc at all (see SearchService.indexSourceFields). */
  stored = new Map<string, Record<string, unknown>>();

  async upsert(d: ProjectionDoc): Promise<void> {
    this.upserts.push(d);
    if (d.sourceFields) this.stored.set(`${d.entityType}/${d.entityId}`, d.sourceFields);
  }
  async tombstone(_p: string, entityType: string, entityId: string, version: number): Promise<void> {
    this.tombstones.push({ entityType, entityId, version });
  }
  async sourceFields(
    _p: string,
    entityType: string,
    entityId: string,
  ): Promise<Record<string, unknown> | null> {
    return this.stored.get(`${entityType}/${entityId}`) ?? null;
  }
}

function build() {
  const writer = new FakeWriter();
  return { writer, apply: new ProjectionApply(writer) };
}

describe('ProjectionApply — partial *.updated diffs (TODO-264)', () => {
  it('contact.updated {changes:[{field,newValue}]} renames the indexed contact', async () => {
    const { writer, apply } = build();
    // Baseline snapshot the way `crm.contact.created` delivers it.
    await apply.apply('crm.contact.created', PID, {
      payload: {
        contactId: 'c1',
        firstName: 'Иван',
        lastName: 'Петров',
        email: 'ivan@example.com',
        phone: '+7 900 111-22-33',
        ownerId: 'user-1',
        departmentId: 'dept-1',
      },
      timestamp: TS,
    });
    expect(writer.upserts[0].title).toBe('Иван Петров');

    // Verbatim contacts.service.ts update() payload: ONLY the changed field.
    const res = await apply.apply('crm.contact.updated', PID, {
      payload: {
        contactId: 'c1',
        changes: [
          { field: 'firstName', oldValue: 'Иван', newValue: 'Пётр', changedAt: 1 },
        ],
      },
      timestamp: '2026-08-16T11:00:00.000Z',
    });

    expect(res).toBe('upsert');
    const doc = writer.upserts[1];
    // The new first name reached the index...
    expect(doc.title).toContain('Пётр');
    // ...and the untouched surname was NOT dropped from title/tokens.
    expect(doc.title).toBe('Пётр Петров');
    expect(doc.tokens).toContain('петров');
    // The subtitle (email · phone) is rebuilt from the stored inputs, not blanked.
    expect(doc.subtitle).toBe('ivan@example.com · +7 900 111-22-33');
  });

  it('company.updated {changedFields:[{field,old,new}]} renames the indexed company', async () => {
    const { writer, apply } = build();
    await apply.apply('crm.company.created', PID, {
      payload: {
        companyId: 'co1',
        name: 'ООО Ромашка',
        inn: '7701234567',
        email: 'info@romashka.ru',
        ownerId: 'user-1',
        departmentId: 'dept-1',
      },
      timestamp: TS,
    });

    // Verbatim companies.service.ts update() payload.
    const res = await apply.apply('crm.company.updated', PID, {
      payload: {
        companyId: 'co1',
        changedFields: [{ field: 'name', old: 'ООО Ромашка', new: 'ООО Лютик' }],
        userId: 'user-1',
      },
      timestamp: '2026-08-16T11:00:00.000Z',
    });

    expect(res).toBe('upsert');
    const doc = writer.upserts[1];
    expect(doc.title).toBe('ООО Лютик');
    // inn/email were not in the diff and must survive in the subtitle.
    expect(doc.subtitle).toBe('7701234567 · info@romashka.ru');
  });

  it('a names-only diff entry never writes an undefined value over a projected field', async () => {
    const { writer, apply } = build();
    await apply.apply('crm.company.created', PID, {
      payload: { companyId: 'co2', name: 'Альфа', ownerId: 'user-1' },
      timestamp: TS,
    });

    await apply.apply('crm.company.updated', PID, {
      // Degenerate producer variant: field names without values.
      payload: { companyId: 'co2', changedFields: [{ field: 'name' }] },
      timestamp: '2026-08-16T11:00:00.000Z',
    });

    expect(writer.upserts[1].title).toBe('Альфа');
  });

  it('a full snapshot still wins over the stored inputs (top-level keys unchanged)', async () => {
    const { writer, apply } = build();
    await apply.apply('crm.deal.created', PID, {
      payload: { dealId: 'd1', name: 'Старая сделка', stageId: 's1', ownerId: 'user-1' },
      timestamp: TS,
    });
    await apply.apply('crm.deal.updated', PID, {
      payload: { dealId: 'd1', name: 'Новая сделка', stageId: 's2', ownerId: 'user-1' },
      timestamp: '2026-08-16T11:00:00.000Z',
    });
    expect(writer.upserts[1].title).toBe('Новая сделка');
    expect(writer.upserts[1].subtitle).toContain('s2');
  });
});

describe('ProjectionApply — merge events (TODO-265)', () => {
  it('crm.contact.merged tombstones the absorbed sources (was "unmapped")', async () => {
    const { writer, apply } = build();
    // Verbatim contacts.service.ts merge() payload.
    const res = await apply.apply('crm.contact.merged', PID, {
      payload: {
        sourceContactIds: ['c-loser'],
        targetContactId: 'c-master',
        mergedBy: 'user-1',
        affectedEntities: { deals: [], orders: [], activities: [], documents: [] },
      },
      timestamp: TS,
    });

    expect(res).toBe('tombstone');
    expect(writer.tombstones.map((t) => t.entityId)).toEqual(['c-loser']);
    // The survivor is NOT blind-upserted: the payload carries no projectable
    // values, and an empty upsert would insert an ownerless orphan.
    expect(writer.upserts).toHaveLength(0);
  });

  it('crm.company.merged tombstones the loser and keeps the master', async () => {
    const { writer, apply } = build();
    const res = await apply.apply('crm.company.merged', PID, {
      payload: {
        masterId: 'co-master',
        loserId: 'co-loser',
        fieldDecisions: { name: 'master' },
        mergedBy: 'user-1',
      },
      timestamp: TS,
    });

    expect(res).toBe('tombstone');
    expect(writer.tombstones.map((t) => t.entityId)).toEqual(['co-loser']);
    expect(writer.upserts.map((u) => u.entityId)).not.toContain('co-master');
  });

  it('crm.company.merge_reverted brings the loser back into the index', async () => {
    const { writer, apply } = build();
    // The loser exists in the index (it was created and then merged away).
    await apply.apply('crm.company.created', PID, {
      payload: { companyId: 'co-loser', name: 'Бета', ownerId: 'user-1' },
      timestamp: TS,
    });
    await apply.apply('crm.company.merged', PID, {
      payload: { masterId: 'co-master', loserId: 'co-loser' },
      timestamp: '2026-08-16T11:00:00.000Z',
    });
    expect(writer.tombstones).toHaveLength(1);

    const res = await apply.apply('crm.company.merge_reverted', PID, {
      payload: { masterId: 'co-master', loserId: 'co-loser' },
      timestamp: '2026-08-16T12:00:00.000Z',
    });

    expect(res).toBe('upsert');
    const revive = writer.upserts[writer.upserts.length - 1];
    expect(revive.entityId).toBe('co-loser');
    // The revive must out-version the tombstone or indexDelete would win.
    expect(revive.version).toBeGreaterThan(writer.tombstones[0].version);
  });

  it('merge_reverted for a never-indexed record inserts nothing (no ownerless orphan)', async () => {
    const { writer, apply } = build();
    const res = await apply.apply('crm.company.merge_reverted', PID, {
      payload: { masterId: 'co-master', loserId: 'co-unknown' },
      timestamp: TS,
    });
    expect(res).toBe('unmapped');
    expect(writer.upserts).toHaveLength(0);
  });

  it('a merge payload without any participant id stays unmapped', async () => {
    const { writer, apply } = build();
    const res = await apply.apply('crm.contact.merged', PID, {
      payload: { mergedBy: 'user-1' },
      timestamp: TS,
    });
    expect(res).toBe('unmapped');
    expect(writer.tombstones).toHaveLength(0);
    expect(writer.upserts).toHaveLength(0);
  });
});

/**
 * TODO-264 (round 1 review): the merge used to be gated on the diff spellings
 * (`changes[]`/`changedFields[]`), so the TRANSITION events — which are just as
 * partial, only without a diff array — still rebuilt the projection from a
 * payload that carries nothing but the moved field. Moving a deal along the
 * pipeline therefore erased its amount from the subtitle and its name from the
 * tokens until the next full reindex. Payload shapes below are verbatim from the
 * producing domains (pipe.service.ts / orders.service.ts).
 */
describe('ProjectionApply — partial NON-diff transition events (TODO-264)', () => {
  async function indexedDeal(apply: ProjectionApply) {
    await apply.apply('crm.deal.created', PID, {
      payload: {
        dealId: 'd1',
        name: 'Поставка станков',
        stageId: 's-new',
        amount: 150000,
        ownerId: 'user-1',
        departmentId: 'dept-1',
      },
      timestamp: TS,
    });
  }

  it('crm.deal.stage_changed keeps the amount in the subtitle and the name in the tokens', async () => {
    const { writer, apply } = build();
    await indexedDeal(apply);
    expect(writer.upserts[0].subtitle).toBe('s-new · 150000');

    // Verbatim pipe.service.ts moveStage() payload — no name, no amount.
    const res = await apply.apply('crm.deal.stage_changed', PID, {
      payload: { dealId: 'd1', fromStageId: 's-new', toStageId: 's-won', movedBy: 'user-1' },
      timestamp: '2026-08-16T11:00:00.000Z',
    });

    expect(res).toBe('upsert');
    const doc = writer.upserts[1];
    // The NEW stage wins over the stored one (the `to*` alias is canonicalized
    // before the merge, so the old stageId cannot shadow it)...
    expect(doc.subtitle).toBe('s-won · 150000');
    expect(doc.title).toBe('Поставка станков');
    expect(doc.tokens).toContain('поставка');
    // ...and it is persisted, so the NEXT partial event merges the new stage.
    expect(doc.sourceFields).toMatchObject({ stageId: 's-won', amount: 150000 });
  });

  it('crm.deal.reassigned (owner-only payload) does not blank title/subtitle', async () => {
    const { writer, apply } = build();
    await indexedDeal(apply);

    const res = await apply.apply('crm.deal.reassigned', PID, {
      payload: { dealId: 'd1', fromOwnerId: 'user-1', toOwnerId: 'user-2' },
      timestamp: '2026-08-16T11:00:00.000Z',
    });

    expect(res).toBe('upsert');
    const doc = writer.upserts[1];
    expect(doc.title).toBe('Поставка станков');
    expect(doc.subtitle).toBe('s-new · 150000');
  });

  it('crm.deal.updated with a values-less `changed[]` keeps the whole projection', async () => {
    const { writer, apply } = build();
    await indexedDeal(apply);

    // Verbatim pipe.service.ts update() payload on a rename: `changed` lists the
    // field NAMES (it is not one of the diff spellings) plus the new flat name.
    await apply.apply('crm.deal.updated', PID, {
      payload: { dealId: 'd1', changed: ['name'], name: 'Поставка прессов' },
      timestamp: '2026-08-16T11:00:00.000Z',
    });

    const doc = writer.upserts[1];
    expect(doc.title).toBe('Поставка прессов');
    expect(doc.subtitle).toBe('s-new · 150000');
  });

  it('crm.order.status_changed {from,to} refreshes the status and keeps the number', async () => {
    const { writer, apply } = build();
    await apply.apply('crm.order.created', PID, {
      payload: { orderId: 'o1', number: 'ORD-7', status: 'NEW', ownerId: 'user-1' },
      timestamp: TS,
    });

    // Verbatim orders.service.ts transition payload.
    const res = await apply.apply('crm.order.status_changed', PID, {
      payload: { orderId: 'o1', from: 'NEW', to: 'DONE' },
      timestamp: '2026-08-16T11:00:00.000Z',
    });

    expect(res).toBe('upsert');
    const doc = writer.upserts[1];
    expect(doc.title).toBe('ORD-7');
    expect(doc.subtitle).toBe('DONE');
    expect(doc.sourceFields).toMatchObject({ number: 'ORD-7', status: 'DONE' });
  });

  it('crm.<entity>.created stays a pure snapshot (no stale input is resurrected)', async () => {
    const { writer, apply } = build();
    await indexedDeal(apply);

    // A re-`created` id (replay / recycled id) must project the payload ALONE.
    await apply.apply('crm.deal.created', PID, {
      payload: { dealId: 'd1', name: 'Другая сделка', stageId: 's-a', ownerId: 'user-2' },
      timestamp: '2026-08-16T11:00:00.000Z',
    });

    const doc = writer.upserts[1];
    expect(doc.title).toBe('Другая сделка');
    expect(doc.subtitle).toBe('s-a');
    expect(doc.sourceFields).not.toHaveProperty('amount');
  });
});
