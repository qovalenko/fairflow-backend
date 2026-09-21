import { withIdempotency, type IdempotencyCollection } from '@fairflow/shared';
import { IdempotencyService } from './idempotency.service';
import { MongoService } from '../mongo/mongo.service';

function makeCollection(): IdempotencyCollection {
  const store = new Map<string, unknown>();
  return {
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
}

describe('IdempotencyService', () => {
  it('runs the executor once and replays the stored response', async () => {
    const collection = makeCollection();
    const mongo = { idempotencyKeys: () => collection } as unknown as MongoService;
    const idem = new IdempotencyService(mongo);
    let runs = 0;
    const run = () =>
      idem.withIdempotency('p1', 'client-key', 'create', async () => {
        runs += 1;
        return { id: 'prod-1', name: 'Plan' };
      });
    const first = await run();
    const second = await run();
    expect(first).toEqual(second);
    expect(runs).toBe(1);
  });

  it('delegates to shared withIdempotency with the mongo collection', async () => {
    const collection = makeCollection();
    const mongo = { idempotencyKeys: () => collection } as unknown as MongoService;
    const idem = new IdempotencyService(mongo);
    let runs = 0;
    await withIdempotency(
      collection,
      { projectId: 'p1', key: 'k1', operation: 'archive' },
      async () => {
        runs += 1;
        return { ok: true };
      },
    );
    await idem.withIdempotency('p1', 'k1', 'archive', async () => {
      runs += 1;
      return { ok: true };
    });
    expect(runs).toBe(1);
  });
});
