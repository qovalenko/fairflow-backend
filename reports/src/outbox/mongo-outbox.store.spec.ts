import { MongoOutboxStore } from './mongo-outbox.store';

describe('MongoOutboxStore', () => {
  function makeStore(opts: {
    insertOne?: jest.Mock;
    find?: jest.Mock;
    updateOne?: jest.Mock;
    findOne?: jest.Mock;
  } = {}) {
    const coll = {
      insertOne: opts.insertOne ?? jest.fn(async () => undefined),
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
      findOne: opts.findOne ?? jest.fn(async () => ({ attempts: 0 })),
    };
    const mongo = {
      outbox: () => coll,
    };
    return { store: new MongoOutboxStore(mongo as never), coll };
  }

  it('enqueue вставляет pending-строку с валидным routing key', async () => {
    const insertOne = jest.fn(async () => undefined);
    const { store } = makeStore({ insertOne });
    const row = await store.enqueue({
      type: 'report.generated',
      source: 'reports',
      projectId: 'p1',
      subject: 'report/r1',
      payload: { reportId: 'r1' },
    });
    expect(row.status).toBe('pending');
    expect(row.routingKey).toBe('report.generated');
    expect(insertOne).toHaveBeenCalledWith(
      expect.objectContaining({ messageId: row.messageId, status: 'pending' }),
    );
  });

  it('enqueue бросает на незарегистрированный routing key', async () => {
    const { store } = makeStore();
    await expect(
      store.enqueue({
        type: 'crm.unknown.event' as never,
        source: 'reports',
        projectId: 'p1',
        payload: {},
      }),
    ).rejects.toThrow(/not registered in the RFC-4 §Р-3 registry/);
  });

  it('fetchPending возвращает pending-строки в порядке createdAt', async () => {
    const docs = [
      {
        messageId: 'm1',
        routingKey: 'report.generated',
        projectId: 'p1',
        status: 'pending',
        attempts: 0,
        envelope: { messageId: 'm1' },
        createdAt: new Date(1),
        updatedAt: new Date(1),
      },
    ];
    const find = jest.fn(() => ({
      sort: () => ({
        limit: (n: number) => {
          expect(n).toBe(5);
          return { toArray: async () => docs };
        },
      }),
    }));
    const { store } = makeStore({ find });
    const rows = await store.fetchPending(5);
    expect(rows).toHaveLength(1);
    expect(rows[0].messageId).toBe('m1');
    expect(find).toHaveBeenCalledWith({ status: 'pending' });
  });

  it('markPublished переводит строку в published', async () => {
    const updateOne = jest.fn(async () => undefined);
    const { store } = makeStore({ updateOne });
    const at = new Date('2026-01-01T00:00:00Z');
    await store.markPublished('m1', at);
    expect(updateOne).toHaveBeenCalledWith(
      { messageId: 'm1' },
      { $set: { status: 'published', publishedAt: at, updatedAt: at } },
    );
  });

  it('markAttemptFailed оставляет pending до maxAttempts', async () => {
    const updateOne = jest.fn(async () => undefined);
    const { store } = makeStore({
      updateOne,
      findOne: jest.fn(async () => ({ attempts: 1 })),
    });
    const at = new Date();
    await store.markAttemptFailed('m1', 'boom', at, 3);
    expect(updateOne).toHaveBeenCalledWith(
      { messageId: 'm1' },
      expect.objectContaining({
        $set: expect.objectContaining({ attempts: 2, status: 'pending', lastError: 'boom' }),
      }),
    );
  });

  it('markAttemptFailed помечает failed после исчерпания попыток', async () => {
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
});
