import type { EventEnvelope } from '@fairflow/shared';
import { TriggerConsumerService } from './trigger-consumer.service';

describe('TriggerConsumerService', () => {
  const retryFlag = process.env.AUTOMATION_SUBSCRIBE_RETRIES;
  const retryMsFlag = process.env.AUTOMATION_SUBSCRIBE_RETRY_MS;
  const queueFlag = process.env.AUTOMATION_TRIGGER_QUEUE;

  afterEach(() => {
    jest.useRealTimers();
    if (retryFlag === undefined) delete process.env.AUTOMATION_SUBSCRIBE_RETRIES;
    else process.env.AUTOMATION_SUBSCRIBE_RETRIES = retryFlag;
    if (retryMsFlag === undefined) delete process.env.AUTOMATION_SUBSCRIBE_RETRY_MS;
    else process.env.AUTOMATION_SUBSCRIBE_RETRY_MS = retryMsFlag;
    if (queueFlag === undefined) delete process.env.AUTOMATION_TRIGGER_QUEUE;
    else process.env.AUTOMATION_TRIGGER_QUEUE = queueFlag;
  });

  it('binds the trigger queue to registered crm.* routing keys', async () => {
    const consumeEnvelope = jest.fn(async (_queue, keys, handler) => {
      expect(keys).toEqual(
        expect.arrayContaining(['crm.deal.created', 'crm.contact.created', 'crm.order.status_changed']),
      );
      const envelope = { type: 'crm.deal.created', projectId: 'p1' } as EventEnvelope;
      await handler(envelope);
    });
    const automation = { consumeEvent: jest.fn(async () => 'ack') };
    const rabbit = { consumeEnvelope };
    const consumer = new TriggerConsumerService(rabbit as never, automation as never);
    await consumer.onModuleInit();
    expect(consumeEnvelope).toHaveBeenCalled();
    expect(automation.consumeEvent).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'crm.deal.created', projectId: 'p1' }),
    );
  });

  it('retries subscription failures up to the configured budget', async () => {
    jest.useFakeTimers();
    process.env.AUTOMATION_SUBSCRIBE_RETRIES = '3';
    process.env.AUTOMATION_SUBSCRIBE_RETRY_MS = '10';
    const consumeEnvelope = jest
      .fn()
      .mockRejectedValueOnce(new Error('broker down'))
      .mockRejectedValueOnce(new Error('broker down'))
      .mockResolvedValue(undefined);
    const rabbit = { consumeEnvelope };
    const consumer = new TriggerConsumerService(rabbit as never, { consumeEvent: jest.fn() } as never);
    const init = consumer.onModuleInit();
    await jest.advanceTimersByTimeAsync(10);
    await jest.advanceTimersByTimeAsync(10);
    await init;
    expect(consumeEnvelope).toHaveBeenCalledTimes(3);
  });
});
