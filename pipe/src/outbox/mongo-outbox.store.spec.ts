import { MongoOutboxStore } from './mongo-outbox.store';
import { MongoService } from '../mongo/mongo.service';

describe('MongoOutboxStore', () => {
  function makeStore(
    opts: {
      txError?: Error;
      insertMany?: jest.Mock;
      find?: jest.Mock;
      updateOne?: jest.Mock;
      findOne?: jest.Mock;
    } = {},
  ) {
    const insertMany = opts.insertMany ?? jest.fn(async () => undefined);
    const coll = {
      insertMany,
      insertOne: jest.fn(async () => undefined),
      find:
        opts.find ??
        jest.fn(() => ({
          sort: () => ({
            limit: () => ({
              toArray: async () => [],
            }),
          }),
        })),
      updateOne: opts.updateOne ?? jest.fn(async () => undefined),
      findOne: opts.findOne ?? jest.fn(async () => ({ attempts: 1 })),
    };
    const session = {
      withTransaction: jest.fn(async (fn: () => Promise<void>) => {
        if (opts.txError) throw opts.txError;
        await fn();
      }),
      endSession: jest.fn(async () => undefined),
    };
    const mongo = {
      outbox: async () => coll,
      getClient: () => ({ startSession: () => session }),
    } as unknown as MongoService;
    return { store: new MongoOutboxStore(mongo), coll, session, insertMany };
  }

  it('withOutbox writes outbox rows in the same transaction as the business result', async () => {
    const { store, insertMany, session } = makeStore();
    const result = await store.withOutbox(async () => ({
      result: 'ok',
      intents: [{ type: 'crm.deal.updated', source: 'pipe', payload: {} }],
    }));
    expect(result).toBe('ok');
    expect(session.withTransaction).toHaveBeenCalled();
    expect(insertMany).toHaveBeenCalledWith(
      expect.arrayContaining([expect.objectContaining({ routingKey: expect.any(String) })]),
      expect.objectContaining({ session: expect.anything() }),
    );
  });

  it('withOutbox falls back to sequential writes when transactions are unavailable', async () => {
    const { store, insertMany } = makeStore({
      txError: new Error('Transaction numbers are only allowed on a replica set member'),
    });
    const result = await store.withOutbox(async () => ({
      result: 42,
      intents: [{ type: 'crm.deal.created', source: 'pipe', payload: {} }],
    }));
    expect(result).toBe(42);
    expect(insertMany).toHaveBeenCalledWith(
      expect.arrayContaining([expect.objectContaining({ status: 'pending' })]),
    );
  });

  it('withOutbox rethrows non-transaction errors', async () => {
    const { store } = makeStore({ txError: new Error('write conflict') });
    await expect(store.withOutbox(async () => ({ result: null, intents: [] }))).rejects.toThrow(
      'write conflict',
    );
  });

  it('fetchPending returns pending rows ordered by createdAt', async () => {
    const docs = [
      { messageId: 'm1', status: 'pending', createdAt: new Date(1), envelope: {}, attempts: 0 },
    ];
    const find = jest.fn(() => ({
      sort: () => ({
        limit: () => ({
          toArray: async () => docs,
        }),
      }),
    }));
    const { store } = makeStore({ find });
    const rows = await store.fetchPending(10);
    expect(rows).toHaveLength(1);
    expect(rows[0].messageId).toBe('m1');
    expect(find).toHaveBeenCalledWith({ status: 'pending' });
  });

  it('markPublished sets status to published', async () => {
    const updateOne = jest.fn(async () => undefined);
    const { store } = makeStore({ updateOne });
    const at = new Date('2026-01-01T00:00:00Z');
    await store.markPublished('m1', at);
    expect(updateOne).toHaveBeenCalledWith(
      { messageId: 'm1' },
      { $set: { status: 'published', publishedAt: at, updatedAt: at } },
    );
  });

  it('markAttemptFailed keeps pending until maxAttempts is reached', async () => {
    const updateOne = jest.fn(async () => undefined);
    const { store } = makeStore({ updateOne, findOne: jest.fn(async () => ({ attempts: 1 })) });
    const at = new Date();
    await store.markAttemptFailed('m1', 'boom', at, 3);
    expect(updateOne).toHaveBeenCalledWith(
      { messageId: 'm1' },
      expect.objectContaining({
        $set: expect.objectContaining({ attempts: 2, status: 'pending', lastError: 'boom' }),
      }),
    );
  });

  it('markAttemptFailed marks failed after the retry budget is exhausted', async () => {
    const updateOne = jest.fn(async () => undefined);
    const { store } = makeStore({
      findOne: jest.fn(async () => ({ attempts: 2 })),
      updateOne,
    });
    await store.markAttemptFailed('m1', 'final', new Date(), 3);
    expect(updateOne).toHaveBeenCalledWith(
      { messageId: 'm1' },
      expect.objectContaining({
        $set: expect.objectContaining({ attempts: 3, status: 'failed' }),
      }),
    );
  });

  it('enqueue inserts a single outbox row', async () => {
    const { store, coll } = makeStore();
    const row = await store.enqueue({
      type: 'crm.deal.updated',
      source: 'pipe',
      payload: { id: 'd-1' },
    });
    expect(row.messageId).toEqual(expect.any(String));
    expect(coll.insertOne).toHaveBeenCalledWith(
      expect.objectContaining({ messageId: row.messageId }),
      {},
    );
  });
});
