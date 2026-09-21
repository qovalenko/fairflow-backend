/**
 * TODO-049: `crm.product.*` events were never projected into the search index.
 *
 * The product domain nests the created payload under `after` and ships updates as
 * a `{ id, changes: [{field, old, new}] }` diff (product.service.ts), while
 * `pickId` only looked at top-level `<entity>Id | entityId | id` — so `apply()`
 * returned 'unmapped', the event was ack'ed and NOTHING was written. These tests
 * feed the REAL producer payload shapes through `ProjectionApply` and assert the
 * upsert/tombstone reaches the delta writer, plus a regression guard that
 * top-level keys keep winning over nested ones for the other entity types.
 */
import {
  ProjectionApply,
  type ProjectionDoc,
  type SearchDeltaWriter,
} from './search-projection.apply';

const PID = 'proj-1';

class FakeWriter implements SearchDeltaWriter {
  upserts: ProjectionDoc[] = [];
  tombstones: Array<{ projectId: string; entityType: string; entityId: string; version: number }> = [];
  async upsert(d: ProjectionDoc): Promise<void> {
    this.upserts.push(d);
  }
  async tombstone(projectId: string, entityType: string, entityId: string, version: number): Promise<void> {
    this.tombstones.push({ projectId, entityType, entityId, version });
  }
}

function build() {
  const writer = new FakeWriter();
  const apply = new ProjectionApply(writer);
  return { writer, apply };
}

const TS = '2026-08-16T10:00:00.000Z';

describe('ProjectionApply — crm.product.* payload shapes (TODO-049)', () => {
  it("indexes crm.product.created whose fields are nested under payload.after (was 'unmapped')", async () => {
    const { writer, apply } = build();
    // Exact shape emitted by product.service.ts create().
    const payload = {
      after: {
        id: '665f1c0000000000000000aa',
        name: 'Widget Deluxe',
        category: 'gadgets',
        orderTypeId: 'ot-1',
        price: 100,
        currency: 'RUB',
      },
    };

    const res = await apply.apply('crm.product.created', PID, { payload, timestamp: TS });

    expect(res).toBe('upsert');
    expect(writer.upserts).toHaveLength(1);
    const doc = writer.upserts[0];
    expect(doc.projectId).toBe(PID);
    expect(doc.entityType).toBe('product');
    expect(doc.entityId).toBe('665f1c0000000000000000aa');
    expect(doc.title).toBe('Widget Deluxe');
    expect(doc.subtitle).toBe('gadgets');
    expect(doc.tokens).toContain('widget');
  });

  it('applies crm.product.updated {id, changes[]} so a rename updates the title', async () => {
    const { writer, apply } = build();
    // Exact shape emitted by product.service.ts update().
    const payload = {
      id: '665f1c0000000000000000aa',
      changes: [
        { field: 'name', old: 'Widget Deluxe', new: 'Widget Ultra' },
        { field: 'category', old: 'gadgets', new: 'premium' },
      ],
    };

    const res = await apply.apply('crm.product.updated', PID, { payload, timestamp: TS });

    expect(res).toBe('upsert');
    const doc = writer.upserts[0];
    expect(doc.entityId).toBe('665f1c0000000000000000aa');
    expect(doc.title).toBe('Widget Ultra');
    expect(doc.subtitle).toBe('premium');
  });

  it('tombstones crm.product.deleted {id}', async () => {
    const { writer, apply } = build();

    const res = await apply.apply('crm.product.deleted', PID, {
      payload: { id: '665f1c0000000000000000aa' },
      timestamp: TS,
    });

    expect(res).toBe('tombstone');
    expect(writer.tombstones).toEqual([
      expect.objectContaining({ projectId: PID, entityType: 'product', entityId: '665f1c0000000000000000aa' }),
    ]);
  });

  it('TODO-051: crm.deal.created with the flat denormalized name is indexed with a title', async () => {
    const { writer, apply } = build();
    // Exact shape emitted by pipe.service.ts createDeal() after TODO-051.
    const payload = {
      dealId: '665f1c0000000000000000bb',
      pipelineId: 'pl-1',
      stageId: 'st-1',
      name: 'Тестовая поставка',
      assigneeId: 'u-1',
      amount: 1000,
      currency: 'RUB',
      contactId: '',
      companyId: '',
      source: '',
    };

    const res = await apply.apply('crm.deal.created', PID, { payload, timestamp: TS });

    expect(res).toBe('upsert');
    const doc = writer.upserts[0];
    expect(doc.entityType).toBe('deal');
    expect(doc.entityId).toBe('665f1c0000000000000000bb');
    expect(doc.title).toBe('Тестовая поставка');
    expect(doc.tokens).toContain('поставка');
  });

  it('TODO-051: crm.deal.updated rename ships the flat name and refreshes the title', async () => {
    const { writer, apply } = build();
    // Exact shape emitted by pipe.service.ts updateDeal() after TODO-051.
    const payload = { dealId: '665f1c0000000000000000bb', changed: ['name'], name: 'Новое имя' };

    const res = await apply.apply('crm.deal.updated', PID, { payload, timestamp: TS });

    expect(res).toBe('upsert');
    expect(writer.upserts[0].title).toBe('Новое имя');
  });

  it('TODO-051: crm.order.created with the flat number is indexed with the number as title', async () => {
    const { writer, apply } = build();
    // Exact shape emitted by orders.service.ts createOrder() after TODO-051
    // (flat number next to ownerId; full row still nested under `after`).
    const payload = {
      orderId: '665f1c0000000000000000cc',
      ownerId: 'u-1',
      productId: 'p-1',
      number: 'ORD-0042',
      after: { number: 'ORD-0042', typeId: 'ot-1', status: 'ACTIVE' },
    };

    const res = await apply.apply('crm.order.created', PID, { payload, timestamp: TS });

    expect(res).toBe('upsert');
    const doc = writer.upserts[0];
    expect(doc.entityType).toBe('order');
    expect(doc.title).toBe('ORD-0042');
  });

  it('TODO-051: crm.activity.created with the flat title is indexed with that title', async () => {
    const { writer, apply } = build();
    // Exact shape emitted by activity.service.ts create() after TODO-051.
    const payload = {
      projectId: PID,
      activityId: '665f1c0000000000000000dd',
      type: 'task',
      assigneeId: 'u-1',
      links: [],
      title: 'Позвонить клиенту',
      dueDate: null,
      createdBy: 'u-1',
      after: { id: '665f1c0000000000000000dd', title: 'Позвонить клиенту', status: 'planned' },
    };

    const res = await apply.apply('crm.activity.created', PID, { payload, timestamp: TS });

    expect(res).toBe('upsert');
    const doc = writer.upserts[0];
    expect(doc.entityType).toBe('activity');
    expect(doc.title).toBe('Позвонить клиенту');
  });

  it('regression guard: top-level keys win over nested after/changes for other entities', async () => {
    const { writer, apply } = build();
    // A flat deal payload must NOT be shadowed by a (hypothetical) nested block.
    const payload = {
      dealId: 'd-top',
      name: 'Top name',
      after: { id: 'd-nested', name: 'Nested name' },
      changes: [{ field: 'name', old: 'x', new: 'Changed name' }],
    };

    const res = await apply.apply('crm.deal.updated', PID, { payload, timestamp: TS });

    expect(res).toBe('upsert');
    const doc = writer.upserts[0];
    expect(doc.entityId).toBe('d-top'); // pickId still prefers <entity>Id
    expect(doc.title).toBe('Top name'); // flat field beats after/changes
  });
});
