import { ObjectId } from 'mongodb';
import type { EmitIntent, VisibilityScope } from '@fairflow/shared';
import { noopSpecValidator } from './test-helpers';
import { OrdersService } from './orders.service';
import type { SourceRead } from './order-drift';

/**
 * Review (PII egress): `CheckDrift` answers with the donor's CURRENT requisites —
 * contact phone/e-mail, company ИНН/КПП. The drift snapshot itself is a system job
 * and is read with the s2s `mode:'all'` scope, so a user holding `orders:read` on
 * an order whose contact they may NOT see was reading that contact's live phone
 * and e-mail straight out of `GET /v1/orders/:id/drift`.
 *
 * Contract pinned here:
 *  - the VERDICT stays system-wide (same `has_drift` for everyone, one stored flag,
 *    the terminal gate keeps working) — the caller's scope is NOT pushed into the
 *    comparison, otherwise an invisible-but-alive donor would masquerade as deleted;
 *  - the PAYLOAD is trimmed: `diffs` of a donor the caller cannot read are dropped,
 *    per entity, leaving `has_drift:true` with no values;
 *  - a genuinely deleted donor is not over-redacted (those diffs only expose the
 *    order's own snapshot);
 *  - the visible case costs exactly one read per donor (no extra round trip).
 */
type AnyRec = Record<string, unknown>;

/** Caller who may only see records of `u7` — i.e. NOT the CRM donors below. */
const USER_SCOPE = {
  mode: 'restricted',
  level: 'custom',
  selfId: 'u7',
  ownerIds: ['u7'],
  sharedRecordIds: [],
} as unknown as VisibilityScope;

const stages = [
  { id: 'os1', name: 'New', order: 0, requiredFieldKeys: [], isTerminal: false },
  { id: 'os2', name: 'Sent', order: 1, requiredFieldKeys: [], isTerminal: true },
];

type Donor = {
  /** What the donor answers to the SYSTEM (mode:'all') read. */
  system: SourceRead;
  /** Whether this donor is visible to the end-user scope (else it masks NOT_FOUND). */
  visibleToUser: boolean;
};

function makeService(opts: {
  docs?: AnyRec[];
  contact?: Donor;
  company?: Donor;
  revision?: AnyRec;
}) {
  const docs = opts.docs ?? [];
  const updates: Array<{ query: AnyRec; update: AnyRec }> = [];
  const emitted: EmitIntent[] = [];
  /** Every donor read, with the scope it carried (undefined = s2s system read). */
  const reads: Array<{ entity: string; id: string; scoped: boolean }> = [];

  const matchesDoc = (doc: AnyRec, filter: AnyRec): boolean =>
    Object.entries(filter).every(([k, v]) => {
      if (k === '_id') return v instanceof ObjectId ? String(doc._id) === String(v) : true;
      if (v && typeof v === 'object' && '$in' in (v as AnyRec)) {
        return ((v as AnyRec).$in as unknown[]).includes(doc[k]);
      }
      return doc[k] === v;
    });

  const ordersColl = {
    findOne: async (filter: AnyRec) => {
      const parts = (filter.$and as AnyRec[]) ?? [filter];
      return docs.find((d) => parts.every((p) => matchesDoc(d, p))) ?? null;
    },
    updateOne: async (query: AnyRec, update: AnyRec) => {
      updates.push({ query, update });
      const doc = docs.find((d) => matchesDoc(d, query));
      if (doc) Object.assign(doc, (update as { $set?: AnyRec }).$set ?? {});
      return { matchedCount: doc ? 1 : 0, modifiedCount: doc ? 1 : 0 };
    },
    countDocuments: async () => docs.length,
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

  /** A donor masks an invisible record exactly as the real ones do: NOT_FOUND. */
  const answer = (donor: Donor | undefined, scope?: VisibilityScope): SourceRead => {
    if (!donor) return { state: 'unknown', fields: {} };
    if (scope && !donor.visibleToUser) return { state: 'deleted', fields: {} };
    return donor.system;
  };

  const sourceReader = {
    readContact: async (_p: string, id: string, scope?: VisibilityScope): Promise<SourceRead> => {
      reads.push({ entity: 'contact', id, scoped: !!scope });
      return answer(opts.contact, scope);
    },
    readCompany: async (_p: string, id: string, scope?: VisibilityScope): Promise<SourceRead> => {
      reads.push({ entity: 'company', id, scoped: !!scope });
      return answer(opts.company, scope);
    },
  } as unknown as ConstructorParameters<typeof OrdersService>[2];

  return {
    service: new OrdersService(mongo, outbox, sourceReader, noopSpecValidator),
    updates,
    emitted,
    reads,
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
  snapshot: { contact: { name: 'Ann', phone: '+70000000001', email: 'ann@x' }, company: {} },
  hasDrift: false,
  finalActionState: { status: 'IDLE', payloadGen: 1, attempts: [] },
  createdAt: 1,
  updatedAt: 1,
  ...over,
});

const CHANGED_CONTACT: SourceRead = {
  state: 'present',
  fields: { name: 'Anna', phone: '+79998887766', email: 'secret@x' },
};

describe('CheckDrift does not leak the requisites of a donor the caller cannot see', () => {
  it('returns the full diffs when the caller may read the contact', async () => {
    const doc = order();
    const { service, reads } = makeService({
      docs: [doc],
      contact: { system: CHANGED_CONTACT, visibleToUser: true },
    });
    const res = await service.checkDrift('p1', String(doc._id), USER_SCOPE);
    expect(res.has_drift).toBe(true);
    expect(res.diffs.map((d) => d.field).sort()).toEqual(['email', 'name', 'phone']);
    expect(res.diffs.find((d) => d.field === 'phone')?.new).toBe('+79998887766');
    // Visible donor → exactly one (scoped) read: no extra system round trip.
    expect(reads).toEqual([{ entity: 'contact', id: 'c1', scoped: true }]);
  });

  it('strips the live values when the contact is invisible, but keeps has_drift', async () => {
    const doc = order();
    const { service, reads, updates } = makeService({
      docs: [doc],
      contact: { system: CHANGED_CONTACT, visibleToUser: false },
    });
    const res = await service.checkDrift('p1', String(doc._id), USER_SCOPE);
    expect(res.has_drift).toBe(true); // the user still learns an accept is needed…
    expect(res.source_state).toBe('present'); // …and NOT that the contact is gone
    expect(res.diffs).toEqual([]); // …but reads no phone/e-mail of it
    expect(JSON.stringify(res)).not.toContain('+79998887766');
    expect(JSON.stringify(res)).not.toContain('secret@x');
    // Verdict is still the system one, so the stored flag stays honest for the gate.
    expect(updates[0].update).toEqual({ $set: { hasDrift: true } });
    expect(doc.hasDrift).toBe(true);
    // NOT_FOUND under the caller's scope is ambiguous → one system read to
    // disambiguate «invisible» from «deleted».
    expect(reads).toEqual([
      { entity: 'contact', id: 'c1', scoped: true },
      { entity: 'contact', id: 'c1', scoped: false },
    ]);
  });

  it('does not over-redact a genuinely deleted donor (diffs are the order own snapshot)', async () => {
    const doc = order();
    const { service } = makeService({
      docs: [doc],
      contact: { system: { state: 'deleted', fields: {} }, visibleToUser: false },
    });
    const res = await service.checkDrift('p1', String(doc._id), USER_SCOPE);
    expect(res.source_state).toBe('deleted');
    expect(res.has_drift).toBe(true);
    expect(res.diffs.map((d) => `${d.field}:${d.old}>${d.new}`).sort()).toEqual([
      'email:ann@x>',
      'name:Ann>',
      'phone:+70000000001>',
    ]);
  });

  it('redacts per entity: a visible contact keeps its diffs, a hidden company loses them', async () => {
    const doc = order({
      companyId: 'co1',
      snapshot: {
        contact: { name: 'Ann', phone: '+70000000001', email: 'ann@x' },
        company: { name: 'Acme', inn: '111', kpp: '222' },
      },
    });
    const { service } = makeService({
      docs: [doc],
      contact: { system: CHANGED_CONTACT, visibleToUser: true },
      company: {
        system: { state: 'present', fields: { name: 'Acme', inn: '7707083893', kpp: '222' } },
        visibleToUser: false,
      },
    });
    const res = await service.checkDrift('p1', String(doc._id), USER_SCOPE);
    expect(res.has_drift).toBe(true);
    expect(res.diffs.every((d) => d.entity === 'contact')).toBe(true);
    expect(JSON.stringify(res)).not.toContain('7707083893');
  });

  it('keeps the fail-soft unknown path (no disambiguating read, no flag write)', async () => {
    const doc = order({ hasDrift: true });
    const { service, reads, updates } = makeService({
      docs: [doc],
      contact: { system: { state: 'unknown', fields: {} }, visibleToUser: true },
    });
    const res = await service.checkDrift('p1', String(doc._id), USER_SCOPE);
    expect(res).toEqual({ has_drift: false, source_state: 'unknown', diffs: [] });
    expect(reads).toHaveLength(1);
    expect(updates).toHaveLength(0);
    expect(doc.hasDrift).toBe(true);
  });
});

describe('the terminal-transition gate stays system-wide (no phantom "deleted")', () => {
  const revision: AnyRec = {
    stages,
    fields: [],
    finalActionSpec: { type: 'webhook', config: { connection_id: 'conn-1' } },
    retryPolicy: { maxAttempts: 3 },
  };

  it('does not block a mover who cannot see an UNCHANGED contact', async () => {
    const doc = order();
    const { service, emitted, reads } = makeService({
      docs: [doc],
      revision,
      contact: {
        system: {
          state: 'present',
          fields: { name: 'Ann', phone: '+70000000001', email: 'ann@x' },
        },
        visibleToUser: false,
      },
    });
    await service.moveOrder('p1', String(doc._id), 'os2', false, USER_SCOPE, [
      'orders',
      'automation',
    ]);
    expect(emitted.some((e) => e.type === 'crm.order.final_action_requested')).toBe(true);
    expect(doc.hasDrift).toBe(false);
    // The gate reads the donor as the system — one read, no scoped probe.
    expect(reads).toEqual([{ entity: 'contact', id: 'c1', scoped: false }]);
  });

  it('still blocks when that invisible contact really drifted', async () => {
    const doc = order();
    const { service, emitted } = makeService({
      docs: [doc],
      revision,
      contact: { system: CHANGED_CONTACT, visibleToUser: false },
    });
    await expect(
      service.moveOrder('p1', String(doc._id), 'os2', false, USER_SCOPE, ['orders', 'automation']),
    ).rejects.toThrow(/DRIFT_NOT_ACCEPTED/);
    expect(emitted.some((e) => e.type === 'crm.order.final_action_requested')).toBe(false);
  });
});
