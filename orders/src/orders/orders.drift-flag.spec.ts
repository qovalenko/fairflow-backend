import { ObjectId } from 'mongodb';
import type { EmitIntent, VisibilityScope } from '@fairflow/shared';
import { OrdersService } from './orders.service';
import { noopSpecValidator } from './test-helpers';
import type { SourceRead } from './order-drift';

/**
 * TODO-213: `hasDrift` used to be written as `false` and nothing else — the card
 * banner and the terminal-transition gate both read that stored flag, so a real
 * requisite change never reached the user and never blocked an order-out.
 *
 * Covered here: CheckDrift persists its determinate verdict, MoveOrder gates on a
 * FRESH computation (not the cached flag), the reactive source-change marker, and
 * the unchanged fail-soft rule (an unreachable donor never moves the flag).
 */
type AnyRec = Record<string, unknown>;

const SCOPE = { mode: 'all', ownerIds: [], sharedRecordIds: [] } as unknown as VisibilityScope;

const stages = [
  { id: 'os1', name: 'New', order: 0, requiredFieldKeys: [], isTerminal: false },
  { id: 'os2', name: 'Sent', order: 1, requiredFieldKeys: [], isTerminal: true },
];

function makeService(opts: {
  docs?: AnyRec[];
  contactRead?: SourceRead | Error;
  companyRead?: SourceRead | Error;
  revision?: AnyRec;
}) {
  const docs = opts.docs ?? [];
  const updates: Array<{ query: AnyRec; update: AnyRec }> = [];
  const manyUpdates: Array<{ query: AnyRec; update: AnyRec }> = [];
  const emitted: EmitIntent[] = [];

  const matchesDoc = (doc: AnyRec, filter: AnyRec): boolean =>
    Object.entries(filter).every(([k, v]) => {
      if (k === '_id') {
        if (v instanceof ObjectId) return String(doc._id) === String(v);
        const range = v as AnyRec;
        if (range && typeof range === 'object' && '$gt' in range) {
          return String(doc._id) > String(range.$gt);
        }
        return true;
      }
      if (v && typeof v === 'object' && '$in' in (v as AnyRec)) {
        return ((v as AnyRec).$in as unknown[]).includes(doc[k]);
      }
      if (v && typeof v === 'object' && '$ne' in (v as AnyRec)) {
        return doc[k] !== (v as AnyRec).$ne;
      }
      return doc[k] === v;
    });

  const ordersColl = {
    findOne: async (filter: AnyRec) => {
      const parts = (filter.$and as AnyRec[]) ?? [filter];
      return docs.find((d) => parts.every((p) => matchesDoc(d, p))) ?? null;
    },
    find: (filter: AnyRec) => {
      let rows = docs.filter((d) => matchesDoc(d, filter));
      const chain = {
        sort: () => chain,
        skip: () => chain,
        limit: (n: number) => {
          rows = rows.slice(0, n);
          return chain;
        },
        toArray: async () => rows,
      };
      return chain;
    },
    updateOne: async (query: AnyRec, update: AnyRec) => {
      updates.push({ query, update });
      const doc = docs.find((d) => matchesDoc(d, query));
      if (doc) Object.assign(doc, (update as { $set?: AnyRec }).$set ?? {});
      return { matchedCount: doc ? 1 : 0, modifiedCount: doc ? 1 : 0 };
    },
    updateMany: async (query: AnyRec, update: AnyRec) => {
      manyUpdates.push({ query, update });
      const ids = ((query._id as AnyRec)?.$in ?? []) as ObjectId[];
      const hit = docs.filter((d) => ids.some((id) => String(id) === String(d._id)));
      for (const doc of hit) Object.assign(doc, (update as { $set?: AnyRec }).$set ?? {});
      return { modifiedCount: hit.length };
    },
    countDocuments: async () => docs.length,
    aggregate: () => ({ toArray: async () => [{}] }),
  };

  const type = { id: 't1', name: 'Sale', currentVersion: 1, stages, fields: [] };
  const mongo = {
    orders: () => ordersColl,
    orderTypes: () => ({
      find: () => ({ toArray: async () => [type] }),
      findOne: async () => type,
    }),
    orderTypeRevisions: () => ({ findOne: async () => opts.revision ?? null }),
  } as unknown as ConstructorParameters<typeof OrdersService>[0];

  const outbox = {
    withOutbox: async <R>(
      work: (s: undefined) => Promise<{ result: R; intents: EmitIntent[] }>,
    ): Promise<R> => {
      const { result, intents } = await work(undefined);
      emitted.push(...intents);
      return result;
    },
  } as unknown as ConstructorParameters<typeof OrdersService>[1];

  const sourceReader = {
    readContact: async (): Promise<SourceRead> => {
      if (opts.contactRead instanceof Error) throw opts.contactRead;
      return opts.contactRead ?? { state: 'unknown', fields: {} };
    },
    readCompany: async (): Promise<SourceRead> => {
      if (opts.companyRead instanceof Error) throw opts.companyRead;
      return opts.companyRead ?? { state: 'unknown', fields: {} };
    },
  } as unknown as ConstructorParameters<typeof OrdersService>[2];

  return {
    service: new OrdersService(mongo, outbox, sourceReader, noopSpecValidator),
    updates,
    manyUpdates,
    emitted,
    docs,
  };
}

const order = (over: AnyRec = {}): AnyRec => ({
  _id: new ObjectId(),
  projectId: 'p1',
  typeId: 't1',
  orderTypeVersion: 1,
  stageId: 'os1',
  number: 'ORD-00001',
  status: 'ACTIVE',
  assigneeId: 'u7',
  contactId: 'c1',
  companyId: '',
  fieldsJson: '{}',
  snapshot: { contact: { name: 'Ann', phone: '+7', email: 'a@x' }, company: {} },
  hasDrift: false,
  finalActionState: { status: 'IDLE', payloadGen: 1, attempts: [] },
  createdAt: 1,
  updatedAt: 1,
  ...over,
});

describe('OrdersService.checkDrift persists the verdict (TODO-213)', () => {
  it('raises the stored hasDrift when a present source diverges', async () => {
    const doc = order();
    const { service, updates } = makeService({
      docs: [doc],
      contactRead: { state: 'present', fields: { name: 'Anna', phone: '+7', email: 'a@x' } },
    });
    const res = await service.checkDrift('p1', String(doc._id), SCOPE);
    expect(res.has_drift).toBe(true);
    expect(doc.hasDrift).toBe(true);
    const set = (updates[0]?.update as { $set: AnyRec }).$set;
    expect(set).toEqual({ hasDrift: true });
    // A read must not reorder the list — updatedAt stays untouched.
    expect(set.updatedAt).toBeUndefined();
  });

  it('clears a stale flag when the sources match again', async () => {
    const doc = order({ hasDrift: true });
    const { service, updates } = makeService({
      docs: [doc],
      contactRead: { state: 'present', fields: { name: 'Ann', phone: '+7', email: 'a@x' } },
    });
    const res = await service.checkDrift('p1', String(doc._id), SCOPE);
    expect(res.has_drift).toBe(false);
    expect(updates[0].update).toEqual({ $set: { hasDrift: false } });
  });

  it('never touches the flag when the donor is unreachable (fail-soft)', async () => {
    const doc = order({ hasDrift: true });
    const { service, updates } = makeService({
      docs: [doc],
      contactRead: { state: 'unknown', fields: {} },
    });
    const res = await service.checkDrift('p1', String(doc._id), SCOPE);
    expect(res.source_state).toBe('unknown');
    expect(res.has_drift).toBe(false); // no false banner…
    expect(updates).toHaveLength(0); // …and no write either way
    expect(doc.hasDrift).toBe(true); // the real drift survives
  });

  it('writes nothing when the verdict already matches the stored flag', async () => {
    const doc = order();
    const { service, updates } = makeService({
      docs: [doc],
      contactRead: { state: 'present', fields: { name: 'Ann', phone: '+7', email: 'a@x' } },
    });
    await service.checkDrift('p1', String(doc._id), SCOPE);
    expect(updates).toHaveLength(0);
  });
});

describe('OrdersService.moveOrder gates on a FRESH drift computation (TODO-213)', () => {
  const revision: AnyRec = {
    stages,
    fields: [],
    finalActionSpec: { type: 'webhook', config: { connection_id: 'conn-1' } },
    retryPolicy: { maxAttempts: 3 },
  };

  it('refuses the terminal move when the live sources drifted, even with hasDrift:false stored', async () => {
    const doc = order({ hasDrift: false });
    const { service, emitted } = makeService({
      docs: [doc],
      revision,
      contactRead: { state: 'present', fields: { name: 'CHANGED', phone: '+7', email: 'a@x' } },
    });
    await expect(
      service.moveOrder('p1', String(doc._id), 'os2', false, SCOPE, ['orders', 'automation']),
    ).rejects.toThrow(/DRIFT_NOT_ACCEPTED/);
    expect(emitted.some((e) => e.type === 'crm.order.final_action_requested')).toBe(false);
    expect(doc.hasDrift).toBe(true); // and the flag is now honest
  });

  it('lets the move through with accept_drift', async () => {
    const doc = order({ hasDrift: false });
    const { service, emitted } = makeService({
      docs: [doc],
      revision,
      contactRead: { state: 'present', fields: { name: 'CHANGED', phone: '+7', email: 'a@x' } },
    });
    await service.moveOrder('p1', String(doc._id), 'os2', true, SCOPE, ['orders', 'automation']);
    expect(emitted.some((e) => e.type === 'crm.order.final_action_requested')).toBe(true);
  });

  it('does not block on a stale stored true when the sources actually match', async () => {
    const doc = order({ hasDrift: true });
    const { service, emitted } = makeService({
      docs: [doc],
      revision,
      contactRead: { state: 'present', fields: { name: 'Ann', phone: '+7', email: 'a@x' } },
    });
    await service.moveOrder('p1', String(doc._id), 'os2', false, SCOPE, ['orders', 'automation']);
    expect(emitted.some((e) => e.type === 'crm.order.final_action_requested')).toBe(true);
  });

  // Review BLOCKER: the gate used to read `drift.has_drift`, and computeOrderDrift
  // answers `has_drift:false` for `source_state:'unknown'` (a display contract — no
  // banner off an unobserved state). A 2s contact timeout therefore walked a really
  // drifted order past the gate and shipped the stale PII snapshot to the ERP.
  it('blocks on the stored flag when the donor is unreachable (fail-CLOSED, not fail-open)', async () => {
    const doc = order({ hasDrift: true });
    const { service, emitted, updates } = makeService({
      docs: [doc],
      revision,
      contactRead: { state: 'unknown', fields: {} },
    });
    await expect(
      service.moveOrder('p1', String(doc._id), 'os2', false, SCOPE, ['orders', 'automation']),
    ).rejects.toThrow(/DRIFT_NOT_ACCEPTED/);
    expect(emitted.some((e) => e.type === 'crm.order.final_action_requested')).toBe(false);
    expect(updates).toHaveLength(0); // unknown never rewrites the flag either way
    expect(doc.hasDrift).toBe(true);
  });

  it('blocks on the stored flag when the source read throws outright', async () => {
    const doc = order({ hasDrift: true });
    const { service, emitted } = makeService({
      docs: [doc],
      revision,
      contactRead: new Error('contact grpc exploded'),
    });
    await expect(
      service.moveOrder('p1', String(doc._id), 'os2', false, SCOPE, ['orders', 'automation']),
    ).rejects.toThrow(/DRIFT_NOT_ACCEPTED/);
    expect(emitted.some((e) => e.type === 'crm.order.final_action_requested')).toBe(false);
  });

  it('accept_drift still overrides the unreachable-donor block', async () => {
    const doc = order({ hasDrift: true });
    const { service, emitted } = makeService({
      docs: [doc],
      revision,
      contactRead: { state: 'unknown', fields: {} },
    });
    await service.moveOrder('p1', String(doc._id), 'os2', true, SCOPE, ['orders', 'automation']);
    expect(emitted.some((e) => e.type === 'crm.order.final_action_requested')).toBe(true);
  });

  // The fallback must not over-block either: nothing was ever known to drift, so an
  // unreachable donor keeps the move going (fail-soft to the stored `false`).
  it('does not block on an unreachable donor when no drift was ever recorded', async () => {
    const doc = order({ hasDrift: false });
    const { service, emitted } = makeService({
      docs: [doc],
      revision,
      contactRead: { state: 'unknown', fields: {} },
    });
    await service.moveOrder('p1', String(doc._id), 'os2', false, SCOPE, ['orders', 'automation']);
    expect(emitted.some((e) => e.type === 'crm.order.final_action_requested')).toBe(true);
  });
});

describe('OrdersService.markSourceDrift — reactive marking (FR-ORDERS-390)', () => {
  it('marks only the orders whose snapshot actually diverges', async () => {
    const stale = order({ contactId: 'c1' });
    const fresh = order({
      contactId: 'c1',
      snapshot: { contact: { name: 'Anna', phone: '+7', email: 'a@x' }, company: {} },
    });
    const other = order({ contactId: 'c2' });
    const { service, docs } = makeService({
      docs: [stale, fresh, other],
      contactRead: { state: 'present', fields: { name: 'Anna', phone: '+7', email: 'a@x' } },
    });
    const res = await service.markSourceDrift('p1', 'contact', 'c1');
    expect(res).toEqual({ scanned: 2, marked: 1 });
    expect(docs[0].hasDrift).toBe(true);
    expect(docs[1].hasDrift).toBe(false);
    expect(docs[2].hasDrift).toBe(false); // another contact — untouched
  });

  it('marks every linked order when the source was deleted', async () => {
    const doc = order({ companyId: 'co1', contactId: '' });
    const { service } = makeService({
      docs: [doc],
      companyRead: { state: 'deleted', fields: {} },
    });
    const res = await service.markSourceDrift('p1', 'company', 'co1');
    expect(res.marked).toBe(1);
    expect(doc.hasDrift).toBe(true);
  });

  it('throws on an unreadable donor so the retry ladder takes over (never guesses)', async () => {
    const doc = order();
    const { service } = makeService({ docs: [doc], contactRead: { state: 'unknown', fields: {} } });
    await expect(service.markSourceDrift('p1', 'contact', 'c1')).rejects.toThrow(/unreadable/);
    expect(doc.hasDrift).toBe(false);
  });

  it('skips orders already flagged and closed ones (monotone, open orders only)', async () => {
    const done = order({ status: 'DONE' });
    const flagged = order({ hasDrift: true });
    const { service } = makeService({
      docs: [done, flagged],
      contactRead: { state: 'present', fields: { name: 'CHANGED', phone: '', email: '' } },
    });
    const res = await service.markSourceDrift('p1', 'contact', 'c1');
    expect(res).toEqual({ scanned: 0, marked: 0 });
  });
});
