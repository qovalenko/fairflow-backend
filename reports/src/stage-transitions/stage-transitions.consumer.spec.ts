import { StageTransitionsConsumer } from './stage-transitions.consumer';

describe('StageTransitionsConsumer', () => {
  const store = { applyTransition: jest.fn() };
  const rabbit = { consume: jest.fn() };
  const consumer = new StageTransitionsConsumer(rabbit as never, store as never);

  beforeEach(() => jest.clearAllMocks());

  it('maps crm.deal.stage_changed into applyTransition', async () => {
    await consumer.handle(
      {
        projectId: 'p1',
        messageId: 'msg-1',
        timestamp: '2026-01-01T00:00:00.000Z',
        payload: { dealId: 'd1', fromStageId: 'a', toStageId: 'b', movedBy: 'u1' },
      },
      'crm.deal.stage_changed',
    );
    expect(store.applyTransition).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: 'p1',
        dealId: 'd1',
        fromStageId: 'a',
        toStageId: 'b',
        messageId: 'msg-1',
      }),
    );
  });

  it('throws when projectId is missing (poison)', async () => {
    await expect(
      consumer.handle({ messageId: 'm', payload: { dealId: 'd1' } }, 'crm.deal.stage_changed'),
    ).rejects.toThrow(/projectId/);
  });

  it('игнорирует чужой routing key', async () => {
    await consumer.handle(
      { projectId: 'p1', messageId: 'm', payload: { dealId: 'd1' } },
      'crm.deal.created',
    );
    expect(store.applyTransition).not.toHaveBeenCalled();
  });

  it('throws when dealId is missing', async () => {
    await expect(
      consumer.handle({ projectId: 'p1', messageId: 'm', payload: {} }, 'crm.deal.stage_changed'),
    ).rejects.toThrow(/dealId/);
  });

  it('использует idempotencyKey как messageId', async () => {
    await consumer.handle(
      {
        projectId: 'p1',
        idempotencyKey: 'idem-1',
        messageId: 'msg-fallback',
        timestamp: '2026-01-01T00:00:00.000Z',
        payload: { dealId: 'd1', fromStageId: 'a', toStageId: 'b' },
      },
      'crm.deal.stage_changed',
    );
    expect(store.applyTransition).toHaveBeenCalledWith(
      expect.objectContaining({ messageId: 'idem-1' }),
    );
  });

  it('onModuleInit не биндит consumer при REPORTS_STAGE_TRANSITIONS_ENABLED=false', async () => {
    const prev = process.env.REPORTS_STAGE_TRANSITIONS_ENABLED;
    process.env.REPORTS_STAGE_TRANSITIONS_ENABLED = 'false';
    const local = new StageTransitionsConsumer(rabbit as never, store as never);
    await local.onModuleInit();
    expect(rabbit.consume).not.toHaveBeenCalled();
    if (prev === undefined) delete process.env.REPORTS_STAGE_TRANSITIONS_ENABLED;
    else process.env.REPORTS_STAGE_TRANSITIONS_ENABLED = prev;
  });

  it('onModuleInit регистрирует очередь stage-transitions', async () => {
    const prev = process.env.REPORTS_STAGE_TRANSITIONS_ENABLED;
    process.env.REPORTS_STAGE_TRANSITIONS_ENABLED = 'true';
    rabbit.consume.mockResolvedValue(undefined);
    await consumer.onModuleInit();
    expect(rabbit.consume).toHaveBeenCalledWith(
      expect.stringContaining('reports.stage-transitions'),
      ['crm.deal.stage_changed'],
      expect.any(Function),
    );
    if (prev === undefined) delete process.env.REPORTS_STAGE_TRANSITIONS_ENABLED;
    else process.env.REPORTS_STAGE_TRANSITIONS_ENABLED = prev;
  });
});
