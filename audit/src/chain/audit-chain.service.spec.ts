import { AuditChainService } from './audit-chain.service';
import { GENESIS_HASH, verifyChain, type ChainRecord } from './hash-chain';

/**
 * In-memory fakes with real Mongo filter semantics for the head CAS. Every
 * operation is atomic per call (as in Mongo), but `await` points between
 * findOne/updateOne let concurrent append() loops interleave — exactly the race
 * TODO-034 is about.
 */
function makeMongoFake() {
  const heads = new Map<string, { seq: number; lastHash: string }>();
  const events: Array<Record<string, unknown>> = [];
  const processed = new Map<string, { state?: string; processedAt: number }>();

  const headsCol = {
    updateOne: async (
      filter: { _id: string; seq?: number; lastHash?: string },
      update: { $set?: Record<string, unknown>; $setOnInsert?: Record<string, unknown> },
      options?: { upsert?: boolean },
    ) => {
      const doc = heads.get(filter._id);
      if (!doc) {
        if (options?.upsert && update.$setOnInsert) {
          heads.set(filter._id, { ...(update.$setOnInsert as { seq: number; lastHash: string }) });
          return { matchedCount: 0, modifiedCount: 0, upsertedCount: 1 };
        }
        return { matchedCount: 0, modifiedCount: 0, upsertedCount: 0 };
      }
      if (
        ('seq' in filter && doc.seq !== filter.seq) ||
        ('lastHash' in filter && doc.lastHash !== filter.lastHash)
      ) {
        return { matchedCount: 0, modifiedCount: 0, upsertedCount: 0 };
      }
      if (update.$set) Object.assign(doc, update.$set);
      return { matchedCount: 1, modifiedCount: 1, upsertedCount: 0 };
    },
    findOne: async (filter: { _id: string }) => {
      const d = heads.get(filter._id);
      return d ? { _id: filter._id, ...d } : null;
    },
  };

  const eventsCol = {
    insertOne: jest.fn(async (doc: Record<string, unknown>) => {
      events.push(doc);
      return { insertedId: doc._id };
    }),
    findOne: async (filter: { idempotencyKey?: string }) =>
      events.find((e) => e.idempotencyKey === filter.idempotencyKey) ?? null,
    find: (filter: { chainKey?: string }) => ({
      sort: () => ({
        toArray: async () =>
          events
            .filter((e) => (filter.chainKey ? e.chainKey === filter.chainKey : true))
            .sort((a, b) => Number(a.seq) - Number(b.seq)),
      }),
    }),
  };

  const processedCol = {
    insertOne: async (doc: { _id: string; state?: string; processedAt: number }) => {
      if (processed.has(doc._id)) {
        const err = new Error('E11000 duplicate key') as Error & { code: number };
        err.code = 11000;
        throw err;
      }
      processed.set(doc._id, { state: doc.state, processedAt: doc.processedAt });
    },
    findOne: async (filter: { _id: string }) => {
      const d = processed.get(filter._id);
      return d ? { _id: filter._id, ...d } : null;
    },
    updateOne: async (filter: { _id: string }, update: { $set: Record<string, unknown> }) => {
      const d = processed.get(filter._id);
      if (d) Object.assign(d, update.$set);
      return { matchedCount: d ? 1 : 0, modifiedCount: d ? 1 : 0 };
    },
  };

  const mongo = {
    auditChainHeads: () => headsCol,
    auditEvents: () => eventsCol,
    processedMessages: () => processedCol,
  };
  return { mongo: mongo as never, heads, events, eventsCol, processedCol, processed };
}

function content(chainKey: string, i: number) {
  return {
    chainKey,
    action: `crm.deal.updated.${i}`,
    subject: `deal/d-${i}`,
    projectId: 'p1',
    createdAt: 1_000 + i,
    data: { i },
  };
}

describe('AuditChainService.append (TODO-034: CAS, no stale prevHash)', () => {
  it('links sequential appends into a verifiable chain (genesis from GENESIS_HASH)', async () => {
    const { mongo, heads } = makeMongoFake();
    const svc = new AuditChainService(mongo);
    const r1 = await svc.append(content('record|p1', 1));
    const r2 = await svc.append(content('record|p1', 2));

    expect(r1.seq).toBe(1);
    expect(r1.prevHash).toBe(GENESIS_HASH);
    expect(r2.seq).toBe(2);
    expect(r2.prevHash).toBe(r1.hash);
    expect(heads.get('record|p1')).toEqual({ seq: 2, lastHash: r2.hash });
    expect(verifyChain([r1, r2])).toEqual({ status: 'ok', checked: 2 });
  });

  it('keeps the chain intact under concurrent appends to one chainKey', async () => {
    const { mongo } = makeMongoFake();
    const svc = new AuditChainService(mongo);
    const n = 50;
    // Interleaved append() loops: without the CAS several of them would read the
    // same head and link to the same stale prevHash (the old $inc + separate
    // lastHash update). With the CAS the losers retry and re-link.
    const records = await Promise.all(
      Array.from({ length: n }, (_, i) => svc.append(content('record|p1', i))),
    );

    const ordered = [...records].sort((a, b) => a.seq - b.seq) as ChainRecord[];
    expect(ordered.map((r) => r.seq)).toEqual(Array.from({ length: n }, (_, i) => i + 1));
    expect(verifyChain(ordered)).toEqual({ status: 'ok', checked: n });
  });

  it('continues from a legacy ($inc-format) head without breaking linkage', async () => {
    const { mongo, heads } = makeMongoFake();
    // Legacy head after 3 appends: seq = count, lastHash = tail hash.
    heads.set('record|p1', { seq: 3, lastHash: 'a'.repeat(64) });
    const svc = new AuditChainService(mongo);
    const r = await svc.append(content('record|p1', 4));
    expect(r.seq).toBe(4);
    expect(r.prevHash).toBe('a'.repeat(64));
  });

  it('rolls the head back when the event insert fails (seq is not burned)', async () => {
    const { mongo, heads, eventsCol } = makeMongoFake();
    const svc = new AuditChainService(mongo);
    eventsCol.insertOne.mockRejectedValueOnce(new Error('mongo down'));

    await expect(svc.append(content('record|p1', 1))).rejects.toThrow('mongo down');
    expect(heads.get('record|p1')).toEqual({ seq: 0, lastHash: GENESIS_HASH });

    // The retried append gets the SAME seq — no gap in the chain.
    const r = await svc.append(content('record|p1', 1));
    expect(r.seq).toBe(1);
    expect(r.prevHash).toBe(GENESIS_HASH);
  });
});

describe('AuditChainService.claimMessage (TODO-033: two-phase dedup)', () => {
  it('claims fresh keys as pending and skips confirmed ones', async () => {
    const { mongo, processed } = makeMongoFake();
    const svc = new AuditChainService(mongo);

    expect(await svc.claimMessage('k1')).toBe(true);
    expect(processed.get('k1')?.state).toBe('pending');

    await svc.confirmMessage('k1');
    expect(processed.get('k1')?.state).toBe('done');
    expect(await svc.claimMessage('k1')).toBe(false);
  });

  it('lets a redelivery re-process a pending claim whose append never landed', async () => {
    const { mongo } = makeMongoFake();
    const svc = new AuditChainService(mongo);
    await svc.claimMessage('k2'); // first attempt claims…
    // …but crashes before append. Redelivery must NOT be dedup-skipped:
    expect(await svc.claimMessage('k2')).toBe(true);
  });

  it('completes the bookkeeping (skip) when the pending append actually landed', async () => {
    const { mongo, processed } = makeMongoFake();
    const svc = new AuditChainService(mongo);
    await svc.claimMessage('k3');
    // Append landed, but the process died before confirmMessage:
    await svc.append({ ...content('record|p1', 1), idempotencyKey: 'k3' });

    expect(await svc.claimMessage('k3')).toBe(false); // no duplicate chain record
    expect(processed.get('k3')?.state).toBe('done'); // claim auto-confirmed
  });

  it('treats legacy claims without state as done', async () => {
    const { mongo, processed } = makeMongoFake();
    const svc = new AuditChainService(mongo);
    processed.set('k-legacy', { processedAt: 1 });
    expect(await svc.claimMessage('k-legacy')).toBe(false);
  });

  it('rethrows non-duplicate insert errors from the dedup ledger', async () => {
    const { mongo, processedCol } = makeMongoFake();
    const svc = new AuditChainService(mongo);
    const err = new Error('mongo unavailable') as Error & { code: number };
    err.code = 13;
    jest.spyOn(processedCol, 'insertOne').mockRejectedValueOnce(err);

    await expect(svc.claimMessage('k-fail')).rejects.toThrow('mongo unavailable');
  });
});

describe('AuditChainService key helpers and verify()', () => {
  it('builds org- and record-level chain keys', () => {
    expect(AuditChainService.orgChainKey('org-1', 'p1')).toBe('org|org-1|p1');
    expect(AuditChainService.orgChainKey('org-1')).toBe('org|org-1|');
    expect(AuditChainService.recordChainKey('p1')).toBe('record|p1');
  });

  it('loadChain returns rows ordered by seq and verify() checks integrity', async () => {
    const { mongo } = makeMongoFake();
    const svc = new AuditChainService(mongo);
    const r1 = await svc.append(content('record|p1', 1));
    const r2 = await svc.append(content('record|p1', 2));

    const loaded = await svc.loadChain('record|p1');
    expect(loaded.map((r) => r.seq)).toEqual([1, 2]);
    expect(await svc.verify('record|p1')).toEqual({ status: 'ok', checked: 2 });
    expect(verifyChain([r1, r2])).toEqual({ status: 'ok', checked: 2 });
  });

  it('persists denormalized entity fields parsed from subject', async () => {
    const { mongo, events } = makeMongoFake();
    const svc = new AuditChainService(mongo);
    await svc.append({
      chainKey: 'record|p1',
      action: 'crm.contact.updated',
      subject: 'contact/c-42',
      projectId: 'p1',
      createdAt: 1_000,
      data: { name: 'Ann' },
    });

    expect(events[0]).toMatchObject({
      entityType: 'contact',
      entityId: 'c-42',
      payloadJson: '{"name":"Ann"}',
    });
  });

  it('stores null entity fields when subject has no slash separator', async () => {
    const { mongo, events } = makeMongoFake();
    const svc = new AuditChainService(mongo);
    await svc.append({
      chainKey: 'org|o1|p1',
      action: 'control.org.changed',
      subject: 'bare-subject',
      organizationId: 'o1',
      projectId: 'p1',
      createdAt: 2_000,
    });

    expect(events[0]).toMatchObject({ entityType: null, entityId: null });
  });
});
