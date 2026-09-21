/**
 * MongoOutboxStore — transactional withOutbox, fallback без replica set, relay CRUD.
 */
import type { EmitIntent } from '@fairflow/shared';
import { MongoOutboxStore } from './mongo-outbox.store';

describe('MongoOutboxStore', () => {
  function makeStore(opts?: { txError?: string }) {
    const outboxRows: Record<string, unknown>[] = [];
    const insertMany = jest.fn(async (_rows: unknown[], _opts?: unknown) => {
      outboxRows.push(...(_rows as Record<string, unknown>[]));
    });
    const insertOne = jest.fn(async (row: unknown) => {
      outboxRows.push(row as Record<string, unknown>);
    });
    const find = jest.fn(() => ({
      sort: () => ({
        limit: () => ({ toArray: async () => outboxRows.filter((r) => r.status === 'pending') }),
      }),
    }));
    const updateOne = jest.fn(
      async (filter: Record<string, unknown>, update: Record<string, unknown>) => {
        const row = outboxRows.find((r) => r.messageId === filter.messageId);
        if (row && update.$set) Object.assign(row, update.$set);
      },
    );
    const findOne = jest.fn(
      async (filter: Record<string, unknown>) =>
        outboxRows.find((r) => r.messageId === filter.messageId) ?? null,
    );
    const coll = { insertMany, insertOne, find, updateOne, findOne };
    const session = {
      withTransaction: jest.fn(async (fn: () => Promise<void>) => {
        if (opts?.txError) throw new Error(opts.txError);
        await fn();
      }),
      endSession: jest.fn(),
    };
    const mongo = {
      outbox: () => coll,
      getClient: () => ({ startSession: () => session }),
    };
    const store = new MongoOutboxStore(mongo as never);
    return { store, outboxRows, insertMany, insertOne, updateOne, findOne, session };
  }

  it('withOutbox в транзакции пишет intents в outbox', async () => {
    const { store, outboxRows } = makeStore();
    const intents: EmitIntent[] = [
      {
        type: 'crm.product.created',
        source: 'product',
        projectId: 'p1',
        subject: 'product/x',
        idempotencyKey: 'k1',
        actorType: 'service',
        payload: { id: 'x' },
      },
    ];

    const result = await store.withOutbox(async () => ({ result: 42, intents }));

    expect(result).toBe(42);
    expect(outboxRows).toHaveLength(1);
    expect(outboxRows[0].routingKey).toBe('crm.product.created');
  });

  it('withOutbox на standalone Mongo падает в sequential fallback', async () => {
    const { store, outboxRows, session } = makeStore({
      txError: 'Transaction numbers are only allowed on a replica set member or mongos',
    });

    await store.withOutbox(async () => ({
      result: 'ok',
      intents: [
        {
          type: 'crm.product.updated',
          source: 'product',
          projectId: 'p1',
          subject: 'product/y',
          idempotencyKey: 'k2',
          actorType: 'service',
          payload: {},
        },
      ],
    }));

    expect(session.endSession).toHaveBeenCalled();
    expect(outboxRows).toHaveLength(1);
    expect(outboxRows[0].routingKey).toBe('crm.product.updated');
  });

  it('fetchPending возвращает pending-строки', async () => {
    const { store, outboxRows } = makeStore();
    outboxRows.push({
      messageId: 'm1',
      routingKey: 'crm.product.created',
      projectId: 'p1',
      status: 'pending',
      attempts: 0,
      envelope: {},
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const rows = await store.fetchPending(10);

    expect(rows).toHaveLength(1);
    expect(rows[0].messageId).toBe('m1');
  });

  it('markAttemptFailed переводит в failed после maxAttempts', async () => {
    const { store, outboxRows, findOne } = makeStore();
    outboxRows.push({
      messageId: 'm2',
      status: 'pending',
      attempts: 2,
    });
    findOne.mockResolvedValue({ messageId: 'm2', attempts: 2 });

    await store.markAttemptFailed('m2', 'boom', new Date('2026-01-01'), 3);

    expect(outboxRows[0].status).toBe('failed');
    expect(outboxRows[0].attempts).toBe(3);
  });

  it('markAttemptFailed оставляет pending, пока attempts < maxAttempts', async () => {
    const { store, outboxRows, findOne } = makeStore();
    outboxRows.push({
      messageId: 'm3',
      status: 'pending',
      attempts: 0,
    });
    findOne.mockResolvedValue({ messageId: 'm3', attempts: 0 });

    await store.markAttemptFailed('m3', 'transient', new Date('2026-01-02'), 3);

    expect(outboxRows[0].status).toBe('pending');
    expect(outboxRows[0].attempts).toBe(1);
    expect(outboxRows[0].lastError).toBe('transient');
  });

  it('markPublished переводит строку в published', async () => {
    const { store, outboxRows } = makeStore();
    outboxRows.push({ messageId: 'm4', status: 'pending', attempts: 0 });
    const at = new Date('2026-02-01T00:00:00Z');

    await store.markPublished('m4', at);

    expect(outboxRows[0].status).toBe('published');
    expect(outboxRows[0].publishedAt).toEqual(at);
  });

  it('enqueue вставляет outbox-строку в активную сессию', async () => {
    const { store, outboxRows, insertOne } = makeStore();
    const session = { id: 'sess-1' };

    const row = await store.enqueue(
      {
        type: 'crm.product.created',
        source: 'product',
        projectId: 'p1',
        subject: 'product/x',
        idempotencyKey: 'k-enq',
        actorType: 'service',
        payload: { id: 'x' },
      },
      session as never,
    );

    expect(row.routingKey).toBe('crm.product.created');
    expect(insertOne).toHaveBeenCalledWith(
      expect.objectContaining({ routingKey: 'crm.product.created' }),
      {
        session,
      },
    );
    expect(outboxRows).toHaveLength(1);
  });

  it('withOutbox пробрасывает ошибки, не связанные с отсутствием транзакций', async () => {
    const { store } = makeStore({ txError: 'connection reset' });

    await expect(store.withOutbox(async () => ({ result: 'x', intents: [] }))).rejects.toThrow(
      'connection reset',
    );
  });

  it('withOutbox без intents не вызывает insertMany в транзакции', async () => {
    const { store, insertMany } = makeStore();

    const result = await store.withOutbox(async () => ({ result: 7, intents: [] }));

    expect(result).toBe(7);
    expect(insertMany).not.toHaveBeenCalled();
  });
});
