import { withIdempotency, type IdempotencyCollection } from '@fairflow/shared';
import { IdempotencyService } from '../idempotency/idempotency.service';
import { MongoService } from '../mongo/mongo.service';

describe('Activity mutation idempotency (NFR-ACT-100)', () => {
  it('withIdempotency replays the first create response', async () => {
    const store = new Map<string, unknown>();
    const collection: IdempotencyCollection = {
      insertOne: async (doc) => {
        const key = `${doc.projectId}:${doc.key}`;
        if (store.has(key)) {
          const err = Object.assign(new Error('dup'), { code: 11000 });
          throw err;
        }
        store.set(key, doc);
      },
      findOne: async ({ projectId, key }) => (store.get(`${projectId}:${key}`) as never) ?? null,
      updateOne: async ({ projectId, key }, { $set }) => {
        const row = store.get(`${projectId}:${key}`) as Record<string, unknown>;
        store.set(`${projectId}:${key}`, { ...row, ...$set });
      },
      deleteOne: async ({ projectId, key }) => {
        store.delete(`${projectId}:${key}`);
      },
    };

    let inserts = 0;
    const executor = async () => {
      inserts += 1;
      return { id: 'act-1', title: 'T' };
    };

    const first = await withIdempotency(
      collection,
      { projectId: 'p1', key: 'idem-1', operation: 'create' },
      executor,
    );
    const second = await withIdempotency(
      collection,
      { projectId: 'p1', key: 'idem-1', operation: 'create' },
      executor,
    );
    expect(first).toEqual(second);
    expect(inserts).toBe(1);
  });

  it('IdempotencyService runs executor once for duplicate keys', async () => {
    const store = new Map<string, unknown>();
    const collection: IdempotencyCollection = {
      insertOne: async (doc) => {
        const key = `${doc.projectId}:${doc.key}`;
        if (store.has(key)) {
          throw Object.assign(new Error('dup'), { code: 11000 });
        }
        store.set(key, doc);
      },
      findOne: async ({ projectId, key }) => (store.get(`${projectId}:${key}`) as never) ?? null,
      updateOne: async ({ projectId, key }, { $set }) => {
        const row = store.get(`${projectId}:${key}`) as Record<string, unknown>;
        store.set(`${projectId}:${key}`, { ...row, ...$set });
      },
      deleteOne: async ({ projectId, key }) => {
        store.delete(`${projectId}:${key}`);
      },
    };
    const mongo = { idempotencyKeys: () => collection } as unknown as MongoService;
    const idem = new IdempotencyService(mongo);
    let runs = 0;
    const run = () =>
      idem.withIdempotency('p1', 'client-key', 'create', async () => {
        runs += 1;
        return { id: 'a1' };
      });
    await run();
    await run();
    expect(runs).toBe(1);
  });

  it('deduplicates complete mutations per operation namespace', async () => {
    const store = new Map<string, unknown>();
    const collection: IdempotencyCollection = {
      insertOne: async (doc) => {
        const key = `${doc.projectId}:${doc.key}`;
        if (store.has(key)) throw Object.assign(new Error('dup'), { code: 11000 });
        store.set(key, doc);
      },
      findOne: async ({ projectId, key }) => (store.get(`${projectId}:${key}`) as never) ?? null,
      updateOne: async ({ projectId, key }, { $set }) => {
        const row = store.get(`${projectId}:${key}`) as Record<string, unknown>;
        store.set(`${projectId}:${key}`, { ...row, ...$set });
      },
      deleteOne: async ({ projectId, key }) => {
        store.delete(`${projectId}:${key}`);
      },
    };
    let runs = 0;
    const exec = async () => {
      runs += 1;
      return { id: 'a9', status: 'completed' };
    };
    await withIdempotency(collection, { projectId: 'p1', key: 'k', operation: 'complete' }, exec);
    await withIdempotency(collection, { projectId: 'p1', key: 'k', operation: 'complete' }, exec);
    expect(runs).toBe(1);
  });
});
