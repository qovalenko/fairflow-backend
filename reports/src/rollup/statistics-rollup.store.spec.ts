import { StatisticsRollupStore } from './statistics-rollup.store';

/**
 * Idempotency of the materialized rollup (P2.f). The store guards every cell by
 * a per-(cell,messageId) claim: a duplicate `messageId` must NOT re-`$inc` the
 * cell. Mongo is mocked — only the store's claim→inc logic is under test.
 */
describe('StatisticsRollupStore.applyIncrement', () => {
  function makeStore() {
    const guardStore = new Map<string, true>();
    const guardUpdate = jest.fn(async (filter: { _id: string }, _update?: unknown) => {
      const id = filter._id;
      if (guardStore.has(id)) return { upsertedCount: 0 };
      guardStore.set(id, true);
      return { upsertedCount: 1 };
    });
    const cellUpdate = jest.fn(
      async (_filter: unknown, _update: unknown) => ({ upsertedCount: 1 }),
    );
    const cellIndex = jest.fn();
    const guardIndex = jest.fn();
    const guardUpdateMany = jest.fn(async () => ({ modifiedCount: 0 }));
    const guardDropIndex = jest.fn();
    const mongo = {
      statisticsRollup: () => ({ updateOne: cellUpdate, createIndex: cellIndex }),
      statisticsRollupMsgs: () => ({
        updateOne: guardUpdate,
        updateMany: guardUpdateMany,
        createIndex: guardIndex,
        dropIndex: guardDropIndex,
      }),
    } as unknown as ConstructorParameters<typeof StatisticsRollupStore>[0];
    const store = new StatisticsRollupStore(mongo);
    return { store, guardUpdate, cellUpdate, guardIndex, guardUpdateMany, guardDropIndex };
  }

  it('increments the cell exactly once for a duplicate messageId', async () => {
    const { store, cellUpdate } = makeStore();
    const inc = {
      projectId: 'p1',
      metric: 'deals_created',
      day: '2026-07-04',
      count: 1,
      amount: 100,
      messageId: 'msg-A',
    };
    await store.applyIncrement(inc);
    await store.applyIncrement(inc); // duplicate delivery
    expect(cellUpdate).toHaveBeenCalledTimes(1);
  });

  it('increments twice for distinct messageIds on the same cell', async () => {
    const { store, cellUpdate } = makeStore();
    const base = { projectId: 'p1', metric: 'deals_won', day: '2026-07-04', count: 1 };
    await store.applyIncrement({ ...base, messageId: 'm1' });
    await store.applyIncrement({ ...base, messageId: 'm2' });
    expect(cellUpdate).toHaveBeenCalledTimes(2);
  });

  it('passes amount into the $inc (defaulting to 0 when omitted)', async () => {
    const { store, cellUpdate } = makeStore();
    await store.applyIncrement({
      projectId: 'p1',
      metric: 'deals_stage_changed',
      day: '2026-07-04',
      count: 1,
      messageId: 'm1',
    });
    const update = cellUpdate.mock.calls[0][1] as { $inc: { value: number; amount: number } };
    expect(update.$inc.value).toBe(1);
    expect(update.$inc.amount).toBe(0);
  });

  /**
   * TODO-497: guard-коллекция росла по строке на КАЖДОЕ событие шины и не имела
   * ни одного индекса — TTL по полю `at` (его пишет applyIncrement) ограничивает
   * её окном дедупликации, а не историей проекта.
   */
  it('creates a TTL index on the dedup-guard collection', async () => {
    const { store, guardIndex } = makeStore();
    process.env.STATISTICS_ROLLUP_MSGS_TTL_SEC = '3600';
    await store.onModuleInit();
    delete process.env.STATISTICS_ROLLUP_MSGS_TTL_SEC;
    expect(guardIndex).toHaveBeenCalledWith(
      { at: 1 },
      expect.objectContaining({ expireAfterSeconds: 3600 }),
    );
  });

  /**
   * TTL истекает документы ТОЛЬКО по полю типа BSON Date: если писать
   * `Date.now()` (число → BSON double), индекс молча ничего не удаляет и
   * TODO-497 остаётся открытым. Поэтому тип записываемого `at` — под тестом.
   */
  it('writes the guard timestamp as a BSON Date (not a number)', async () => {
    const { store, guardUpdate } = makeStore();
    await store.applyIncrement({
      projectId: 'p1',
      metric: 'deals_created',
      day: '2026-07-04',
      count: 1,
      messageId: 'm1',
    });
    const update = guardUpdate.mock.calls[0][1] as unknown as {
      $setOnInsert: { at: unknown };
    };
    expect(update.$setOnInsert.at).toBeInstanceOf(Date);
    expect(typeof update.$setOnInsert.at).not.toBe('number');
  });

  /**
   * Строки, записанные до правки, имеют `at` числом или не имеют его вовсе —
   * TTL их не тронет никогда. onModuleInit приводит тип разово, конвертируя
   * число в исходный момент и не удаляя ни одной живой заявки.
   */
  it('normalizes legacy non-Date guard timestamps on init', async () => {
    const { store, guardUpdateMany } = makeStore();
    await store.onModuleInit();
    expect(guardUpdateMany).toHaveBeenCalledTimes(1);
    const [filter, pipeline] = guardUpdateMany.mock.calls[0] as unknown as [
      Record<string, unknown>,
      unknown[],
    ];
    expect(filter).toEqual({ at: { $not: { $type: 'date' } } });
    expect(pipeline).toEqual([
      { $set: { at: { $toDate: { $ifNull: ['$at', '$$NOW'] } } } },
    ]);
  });

  /**
   * Смена `STATISTICS_ROLLUP_MSGS_TTL_SEC` при уже существующем индексе даёт
   * IndexOptionsConflict (code 85) — окно должно переехать, а не уронить старт.
   */
  it('recreates the TTL index when the configured window changed', async () => {
    const { store, guardIndex, guardDropIndex } = makeStore();
    guardIndex.mockImplementationOnce(() => {
      throw Object.assign(new Error('Index already exists with different options'), {
        code: 85,
      });
    });
    process.env.STATISTICS_ROLLUP_MSGS_TTL_SEC = '600';
    await store.onModuleInit();
    delete process.env.STATISTICS_ROLLUP_MSGS_TTL_SEC;
    expect(guardDropIndex).toHaveBeenCalledWith('stats_rollup_msgs_ttl');
    expect(guardIndex).toHaveBeenLastCalledWith(
      { at: 1 },
      expect.objectContaining({ expireAfterSeconds: 600 }),
    );
  });

  /** Ошибка не про конфликт опций обязана всплыть, а не быть проглоченной. */
  it('rethrows non-conflict index errors', async () => {
    const { store, guardIndex, guardDropIndex } = makeStore();
    guardIndex.mockImplementationOnce(() => {
      throw Object.assign(new Error('not authorized'), { code: 13 });
    });
    await expect(store.onModuleInit()).rejects.toThrow('not authorized');
    expect(guardDropIndex).not.toHaveBeenCalled();
  });
});
