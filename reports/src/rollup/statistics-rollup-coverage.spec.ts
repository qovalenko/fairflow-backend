import { StatisticsRollupCoverageStore } from './statistics-rollup-coverage';

describe('StatisticsRollupCoverageStore', () => {
  const col = {
    createIndex: jest.fn(async () => 'ix'),
    findOne: jest.fn(),
    updateOne: jest.fn(async () => ({ upsertedCount: 1 })),
  };
  const mongo = {
    statisticsRollupState: () => col,
  };
  const store = new StatisticsRollupCoverageStore(mongo as never);

  beforeEach(() => jest.clearAllMocks());

  it('onModuleInit создаёт уникальный индекс по projectId', async () => {
    await store.onModuleInit();
    expect(col.createIndex).toHaveBeenCalledWith(
      { projectId: 1 },
      { unique: true, name: 'stats_rollup_state_project' },
    );
  });

  it('get возвращает null для пустого projectId', async () => {
    expect(await store.get('')).toBeNull();
    expect(col.findOne).not.toHaveBeenCalled();
  });

  it('get возвращает документ маркера backfill', async () => {
    const doc = { projectId: 'p1', backfilledFromDay: '2026-01-01', backfilledAt: 1 };
    col.findOne.mockResolvedValue(doc);
    expect(await store.get('p1')).toEqual(doc);
    expect(col.findOne).toHaveBeenCalledWith({ projectId: 'p1' });
  });

  it('markBackfilled no-op при пустых аргументах', async () => {
    await store.markBackfilled('', '2026-01-01');
    await store.markBackfilled('p1', '');
    expect(col.updateOne).not.toHaveBeenCalled();
  });

  it('markBackfilled upsert-ит маркер backfill', async () => {
    await store.markBackfilled('p1', '2026-01-01');
    expect(col.updateOne).toHaveBeenCalledWith(
      { projectId: 'p1' },
      expect.objectContaining({
        $set: expect.objectContaining({
          projectId: 'p1',
          backfilledFromDay: '2026-01-01',
        }),
      }),
      { upsert: true },
    );
  });

  it('isTrusted отклоняет диапазон без маркера или при выключенном флаге', () => {
    const prev = process.env.STATISTICS_ROLLUP_READ_ENABLED;
    process.env.STATISTICS_ROLLUP_READ_ENABLED = 'true';
    const state = { projectId: 'p1', backfilledFromDay: '2026-01-10', backfilledAt: 1 };
    expect(store.isTrusted(null, '2026-01-01')).toBe(false);
    expect(store.isTrusted(state, '2026-01-09')).toBe(false);
    expect(store.isTrusted(state, '2026-01-10')).toBe(true);
    process.env.STATISTICS_ROLLUP_READ_ENABLED = 'false';
    expect(store.isTrusted(state, '2026-01-10')).toBe(false);
    if (prev === undefined) delete process.env.STATISTICS_ROLLUP_READ_ENABLED;
    else process.env.STATISTICS_ROLLUP_READ_ENABLED = prev;
  });
});
