import { StatisticsRollupConsumer } from './statistics-rollup.consumer';
import type { StatisticsRollupStore, RollupIncrement } from './statistics-rollup.store';

/**
 * Event→metric mapping + poison handling for the rollup consumer (P2.f). The
 * store is mocked — only the routing-key → increment translation and the
 * malformed-event (poison → throw → dead-letter) path are under test.
 */
describe('StatisticsRollupConsumer.handle', () => {
  function makeConsumer() {
    const applyIncrement = jest.fn(async (_inc: RollupIncrement) => undefined);
    const store = { applyIncrement } as unknown as StatisticsRollupStore;
    const rabbit = { consume: jest.fn() } as never;
    const consumer = new StatisticsRollupConsumer(rabbit, store);
    return { consumer, applyIncrement };
  }

  const envelope = (over: Record<string, unknown> = {}) => ({
    type: 'crm.deal.created',
    messageId: 'msg-1',
    timestamp: '2026-07-04T10:00:00.000Z',
    projectId: 'p1',
    payload: { dealId: 'd1', amount: 1000 },
    ...over,
  });

  it('maps crm.deal.created → deals_created with amount + UTC day', async () => {
    const { consumer, applyIncrement } = makeConsumer();
    await consumer.handle(envelope(), 'crm.deal.created');
    expect(applyIncrement).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: 'p1',
        metric: 'deals_created',
        day: '2026-07-04',
        count: 1,
        amount: 1000,
        messageId: 'msg-1',
      }),
    );
  });

  it('maps crm.deal.stage_changed → deals_stage_changed (no amount)', async () => {
    const { consumer, applyIncrement } = makeConsumer();
    await consumer.handle(
      envelope({ type: 'crm.deal.stage_changed', payload: { dealId: 'd1' } }),
      'crm.deal.stage_changed',
    );
    const inc = applyIncrement.mock.calls[0][0];
    expect(inc.metric).toBe('deals_stage_changed');
    expect(inc.amount).toBeUndefined();
  });

  it('maps crm.activity.completed → activities_completed', async () => {
    const { consumer, applyIncrement } = makeConsumer();
    await consumer.handle(envelope({ type: 'crm.activity.completed' }), 'crm.activity.completed');
    expect(applyIncrement.mock.calls[0][0].metric).toBe('activities_completed');
  });

  it('prefers idempotencyKey over messageId for dedup', async () => {
    const { consumer, applyIncrement } = makeConsumer();
    await consumer.handle(envelope({ idempotencyKey: 'idem-9' }), 'crm.deal.created');
    expect(applyIncrement.mock.calls[0][0].messageId).toBe('idem-9');
  });

  it('ack-drops a bound-but-unmapped routing key (crm.order.stage_changed)', async () => {
    const { consumer, applyIncrement } = makeConsumer();
    await consumer.handle(envelope({ type: 'crm.order.stage_changed' }), 'crm.order.stage_changed');
    expect(applyIncrement).not.toHaveBeenCalled();
  });

  it('throws (poison → dead-letter) when projectId is missing', async () => {
    const { consumer, applyIncrement } = makeConsumer();
    await expect(
      consumer.handle(envelope({ projectId: undefined }), 'crm.deal.created'),
    ).rejects.toThrow(/projectId/);
    expect(applyIncrement).not.toHaveBeenCalled();
  });

  it('throws when neither messageId nor idempotencyKey is present', async () => {
    const { consumer } = makeConsumer();
    await expect(
      consumer.handle(envelope({ messageId: undefined }), 'crm.deal.created'),
    ).rejects.toThrow(/messageId/);
  });
});

/**
 * TODO-497/TODO-469, вариант «отключить запись»: витрина `statistics_rollup`
 * пишется и пока НЕ читается (read-switch ждёт backfill-джобу), поэтому
 * единственная гарантия, которую обязан давать домен, — что kill-switch
 * действительно снимает подписку, а не просто пишет строку в лог. Флаг читается
 * в инициализаторе поля, т.е. на КОНСТРУИРОВАНИИ провайдера, — поэтому env
 * выставляется до `new`.
 */
describe('StatisticsRollupConsumer.onModuleInit (REPORTS_ROLLUP_CONSUMER_ENABLED)', () => {
  const prev = process.env.REPORTS_ROLLUP_CONSUMER_ENABLED;

  afterEach(() => {
    if (prev === undefined) delete process.env.REPORTS_ROLLUP_CONSUMER_ENABLED;
    else process.env.REPORTS_ROLLUP_CONSUMER_ENABLED = prev;
  });

  function makeConsumerWithRabbit() {
    const consume = jest.fn(async () => undefined);
    const rabbit = { consume } as unknown as ConstructorParameters<
      typeof StatisticsRollupConsumer
    >[0];
    const store = { applyIncrement: jest.fn() } as unknown as StatisticsRollupStore;
    return { consumer: new StatisticsRollupConsumer(rabbit, store), consume };
  }

  it('binds the queue by default (флаг не выставлен — консьюмер включён)', async () => {
    delete process.env.REPORTS_ROLLUP_CONSUMER_ENABLED;
    const { consumer, consume } = makeConsumerWithRabbit();
    await consumer.onModuleInit();
    expect(consume).toHaveBeenCalledTimes(1);
  });

  it('does NOT bind the queue when the kill-switch is set to false', async () => {
    process.env.REPORTS_ROLLUP_CONSUMER_ENABLED = 'false';
    const { consumer, consume } = makeConsumerWithRabbit();
    await consumer.onModuleInit();
    expect(consume).not.toHaveBeenCalled();
  });

  it('treats any other value as enabled (только явное "false" выключает запись)', async () => {
    process.env.REPORTS_ROLLUP_CONSUMER_ENABLED = 'true';
    const { consumer, consume } = makeConsumerWithRabbit();
    await consumer.onModuleInit();
    expect(consume).toHaveBeenCalledTimes(1);
  });
});
