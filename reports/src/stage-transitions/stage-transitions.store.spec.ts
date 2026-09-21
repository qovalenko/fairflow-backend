import { StageTransitionsStore } from './stage-transitions.store';

describe('StageTransitionsStore', () => {
  const col = {
    createIndex: jest.fn(),
    findOne: jest.fn(),
    updateMany: jest.fn(),
    insertOne: jest.fn(),
    find: jest.fn(),
    aggregate: jest.fn(),
  };
  const mongo = {
    stageTransitions: () => col,
  };
  const store = new StageTransitionsStore(mongo as never);

  beforeEach(() => jest.clearAllMocks());

  it('applyTransition is idempotent by messageId', async () => {
    col.findOne.mockResolvedValue({ projectId: 'p1' });
    await store.applyTransition({
      projectId: 'p1',
      dealId: 'd1',
      fromStageId: 's1',
      toStageId: 's2',
      enteredAt: 100,
      messageId: 'm1',
    });
    expect(col.insertOne).not.toHaveBeenCalled();
  });

  it('applyTransition closes open leg and inserts new row', async () => {
    col.findOne.mockResolvedValue(null);
    col.updateMany.mockResolvedValue({ modifiedCount: 1 });
    col.insertOne.mockResolvedValue({});
    await store.applyTransition({
      projectId: 'p1',
      dealId: 'd1',
      fromStageId: 's1',
      toStageId: 's2',
      enteredAt: 200,
      messageId: 'm2',
    });
    expect(col.updateMany).toHaveBeenCalled();
    expect(col.insertOne).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: 'p1',
        dealId: 'd1',
        kind: 'move',
        messageId: 'm2',
      }),
    );
  });

  it('listForDeal возвращает [] при пустых аргументах', async () => {
    expect(await store.listForDeal('', 'd1')).toEqual([]);
    expect(await store.listForDeal('p1', '')).toEqual([]);
    expect(col.find).not.toHaveBeenCalled();
  });

  it('listForDeal сортирует timeline сделки', async () => {
    const rows = [{ enteredAt: 1, messageId: 'a' }, { enteredAt: 2, messageId: 'b' }];
    col.find.mockReturnValue({
      sort: () => ({ toArray: async () => rows }),
    });
    expect(await store.listForDeal('p1', 'd1')).toEqual(rows);
    expect(col.find).toHaveBeenCalledWith({ projectId: 'p1', dealId: 'd1' });
  });

  it('avgDurationByStage возвращает [] без projectId', async () => {
    expect(await store.avgDurationByStage('', 0, 100)).toEqual([]);
    expect(col.aggregate).not.toHaveBeenCalled();
  });

  it('avgDurationByStage вычисляет среднее dwell по toStageId', async () => {
    col.aggregate.mockReturnValue({
      toArray: async () => [
        { _id: 'stage-a', count: 2, totalMs: 300 },
        { _id: 'stage-b', count: 0, totalMs: 0 },
      ],
    });
    const rows = await store.avgDurationByStage('p1', 0, 1000);
    expect(rows).toEqual([
      { stageId: 'stage-a', count: 2, avgDurationMs: 150 },
      { stageId: 'stage-b', count: 0, avgDurationMs: 0 },
    ]);
  });

  it('onModuleInit создаёт индексы идемпотентности и метрик', async () => {
    await store.onModuleInit();
    expect(col.createIndex).toHaveBeenCalledTimes(3);
    expect(col.createIndex).toHaveBeenCalledWith(
      { projectId: 1, dealId: 1, messageId: 1 },
      { unique: true, name: 'stage_transitions_idempotent' },
    );
  });
});
