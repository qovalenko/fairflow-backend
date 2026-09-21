import type { ClientSession } from 'mongodb';
import { MongoOutboxStore } from './mongo-outbox.store';
import type { EmitIntent } from '@fairflow/shared';

function intent(type = 'crm.contact.updated'): EmitIntent {
  return {
    type,
    source: 'contact',
    projectId: 'p1',
    subject: 'contact/x',
    idempotencyKey: 'k1',
    payload: { contactId: 'x' },
  };
}

describe('MongoOutboxStore', () => {
  it('withOutbox: transactional path inserts outbox rows', async () => {
    const insertMany = jest.fn().mockResolvedValue(undefined);
    const session = {
      withTransaction: async (fn: () => Promise<void>) => fn(),
      endSession: jest.fn().mockResolvedValue(undefined),
    };
    const mongo = {
      outbox: async () => ({ insertMany }),
      getClient: () => ({ startSession: () => session }),
    };
    const store = new MongoOutboxStore(mongo as never);
    const result = await store.withOutbox(async () => ({
      result: 42,
      intents: [intent()],
    }));
    expect(result).toBe(42);
    expect(insertMany).toHaveBeenCalledWith(
      [expect.objectContaining({ routingKey: intent().type })],
      {
        session,
      },
    );
  });

  it('withOutbox: fallback без транзакций пишет outbox после business write', async () => {
    const insertMany = jest.fn().mockResolvedValue(undefined);
    let txCalls = 0;
    const session = {
      withTransaction: async () => {
        txCalls += 1;
        if (txCalls === 1)
          throw new Error('Transaction numbers are only allowed on a replica set member');
        return undefined;
      },
      endSession: jest.fn().mockResolvedValue(undefined),
    };
    const mongo = {
      outbox: async () => ({ insertMany }),
      getClient: () => ({ startSession: () => session }),
    };
    const store = new MongoOutboxStore(mongo as never);
    const result = await store.withOutbox(async (_s: ClientSession | undefined) => ({
      result: 'ok',
      intents: [intent()],
    }));
    expect(result).toBe('ok');
    expect(insertMany).toHaveBeenCalledTimes(1);
    expect(insertMany.mock.calls[0][1]).toBeUndefined();
  });

  it('fetchPending возвращает pending-строки', async () => {
    const docs = [
      {
        messageId: 'm1',
        routingKey: 'crm.contact.updated',
        projectId: 'p1',
        status: 'pending',
        attempts: 0,
        envelope: {},
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ];
    const coll = {
      find: () => ({
        sort: () => ({
          limit: () => ({ toArray: async () => docs }),
        }),
      }),
    };
    const store = new MongoOutboxStore({ outbox: async () => coll } as never);
    const rows = await store.fetchPending(5);
    expect(rows).toHaveLength(1);
    expect(rows[0].messageId).toBe('m1');
  });

  it('markPublished обновляет статус', async () => {
    const updateOne = jest.fn().mockResolvedValue(undefined);
    const store = new MongoOutboxStore({ outbox: async () => ({ updateOne }) } as never);
    const at = new Date('2026-01-01T00:00:00Z');
    await store.markPublished('m1', at);
    expect(updateOne).toHaveBeenCalledWith(
      { messageId: 'm1' },
      { $set: { status: 'published', publishedAt: at, updatedAt: at } },
    );
  });

  it('markAttemptFailed переводит в failed после maxAttempts', async () => {
    const updateOne = jest.fn().mockResolvedValue(undefined);
    const findOne = jest.fn().mockResolvedValue({ attempts: 2 });
    const store = new MongoOutboxStore({
      outbox: async () => ({ findOne, updateOne }),
    } as never);
    const at = new Date();
    await store.markAttemptFailed('m1', 'boom', at, 3);
    expect(updateOne).toHaveBeenCalledWith(
      { messageId: 'm1' },
      {
        $set: expect.objectContaining({ status: 'failed', attempts: 3, lastError: 'boom' }),
      },
    );
  });

  it('enqueue вставляет одну outbox-строку', async () => {
    const insertOne = jest.fn().mockResolvedValue(undefined);
    const store = new MongoOutboxStore({ outbox: async () => ({ insertOne }) } as never);
    const row = await store.enqueue(intent());
    expect(row.routingKey).toBe('crm.contact.updated');
    expect(insertOne).toHaveBeenCalled();
  });
});
