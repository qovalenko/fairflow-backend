import type { EventEnvelope } from '@fairflow/shared';
import { UsageConsumerService } from './usage-consumer.service';
import { ModuleSubscriptionService } from './module-subscription.service';
import { RabbitMqService } from '../messaging/rabbitmq.service';

describe('UsageConsumerService.handle', () => {
  let modules: { incrementUsage: jest.Mock };
  let service: UsageConsumerService;

  beforeEach(() => {
    modules = { incrementUsage: jest.fn().mockResolvedValue({ ok: true }) };
    service = new UsageConsumerService(
      modules as unknown as ModuleSubscriptionService,
      {} as RabbitMqService,
    );
  });

  it('ignores routing-keys that are not mapped to usage', async () => {
    await service.handle({
      type: 'unknown.event',
      projectId: 'p-1',
      messageId: 'm-1',
    } as EventEnvelope);
    expect(modules.incrementUsage).not.toHaveBeenCalled();
  });

  it('ignores envelopes without projectId or dedup key', async () => {
    await service.handle({
      type: 'document.generated',
      projectId: '',
      messageId: 'm-1',
    } as EventEnvelope);
    await service.handle({ type: 'document.generated', projectId: 'p-1' } as EventEnvelope);
    expect(modules.incrementUsage).not.toHaveBeenCalled();
  });

  it('increments usage for mapped facts using idempotencyKey when present', async () => {
    await service.handle({
      type: 'document.generated',
      projectId: 'p-1',
      idempotencyKey: 'idem-1',
      messageId: 'msg-fallback',
    } as EventEnvelope);
    expect(modules.incrementUsage).toHaveBeenCalledWith({
      projectId: 'p-1',
      module: 'documents',
      metric: 'documents.generate',
      delta: 1,
      messageId: 'idem-1',
    });
  });

  it('falls back to messageId when idempotencyKey is absent', async () => {
    await service.handle({
      type: 'automation.rule.executed',
      projectId: 'p-2',
      messageId: 'msg-2',
    } as EventEnvelope);
    expect(modules.incrementUsage).toHaveBeenCalledWith({
      projectId: 'p-2',
      module: 'automation',
      metric: 'automation.run',
      delta: 1,
      messageId: 'msg-2',
    });
  });

  it('increments usage for crm.activity.completed', async () => {
    await service.handle({
      type: 'crm.activity.completed',
      projectId: 'p-3',
      messageId: 'msg-3',
    } as EventEnvelope);
    expect(modules.incrementUsage).toHaveBeenCalledWith({
      projectId: 'p-3',
      module: 'activities',
      metric: 'activity.completed',
      delta: 1,
      messageId: 'msg-3',
    });
  });
});

describe('UsageConsumerService.onModuleInit', () => {
  it('does not bind the consumer when BILLING_CONSUMER_DISABLED=true', async () => {
    const prev = process.env.BILLING_CONSUMER_DISABLED;
    process.env.BILLING_CONSUMER_DISABLED = 'true';
    const rabbit = { consume: jest.fn() };
    const service = new UsageConsumerService({} as ModuleSubscriptionService, rabbit as never);
    await service.onModuleInit();
    expect(rabbit.consume).not.toHaveBeenCalled();
    process.env.BILLING_CONSUMER_DISABLED = prev;
  });

  it('starts consumption on the default queue when enabled', async () => {
    const prev = process.env.BILLING_CONSUMER_DISABLED;
    delete process.env.BILLING_CONSUMER_DISABLED;
    const rabbit = { consume: jest.fn().mockResolvedValue(undefined) };
    const service = new UsageConsumerService({} as ModuleSubscriptionService, rabbit as never);
    await service.onModuleInit();
    expect(rabbit.consume).toHaveBeenCalledWith(
      expect.any(String),
      expect.arrayContaining(['document.generated']),
      expect.any(Function),
    );
    process.env.BILLING_CONSUMER_DISABLED = prev;
  });

  it('binds a custom queue from BILLING_USAGE_QUEUE when set', async () => {
    const prevDisabled = process.env.BILLING_CONSUMER_DISABLED;
    const prevQueue = process.env.BILLING_USAGE_QUEUE;
    delete process.env.BILLING_CONSUMER_DISABLED;
    process.env.BILLING_USAGE_QUEUE = 'billing.usage.custom';
    const rabbit = { consume: jest.fn().mockResolvedValue(undefined) };
    const service = new UsageConsumerService({} as ModuleSubscriptionService, rabbit as never);
    await service.onModuleInit();
    expect(rabbit.consume).toHaveBeenCalledWith(
      'billing.usage.custom',
      expect.any(Array),
      expect.any(Function),
    );
    if (prevDisabled === undefined) delete process.env.BILLING_CONSUMER_DISABLED;
    else process.env.BILLING_CONSUMER_DISABLED = prevDisabled;
    if (prevQueue === undefined) delete process.env.BILLING_USAGE_QUEUE;
    else process.env.BILLING_USAGE_QUEUE = prevQueue;
  });

  it('logs and survives when the broker bind fails', async () => {
    const prev = process.env.BILLING_CONSUMER_DISABLED;
    delete process.env.BILLING_CONSUMER_DISABLED;
    const rabbit = { consume: jest.fn().mockRejectedValue(new Error('broker down')) };
    const service = new UsageConsumerService({} as ModuleSubscriptionService, rabbit as never);
    await expect(service.onModuleInit()).resolves.toBeUndefined();
    expect(rabbit.consume).toHaveBeenCalled();
    process.env.BILLING_CONSUMER_DISABLED = prev;
  });
});
