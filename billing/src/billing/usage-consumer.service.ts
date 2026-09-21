import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import type { EventEnvelope } from '@fairflow/shared';
import { busQueueName } from '@fairflow/shared';
import { RabbitMqService } from '../messaging/rabbitmq.service';
import { ModuleSubscriptionService } from './module-subscription.service';

/**
 * Maps an inbound bus routing-key to a usage `(module, metric)` pair (RFC-4 §5.2
 * of the billing contract). Only registered facts produce usage; anything else
 * is ignored so the queue stays cheap.
 */
const USAGE_MAP: Record<string, { module: string; metric: string }> = {
  'document.generated': { module: 'documents', metric: 'documents.generate' },
  'automation.rule.executed': { module: 'automation', metric: 'automation.run' },
  'crm.activity.completed': { module: 'activities', metric: 'activity.completed' },
};

/** Bus routing-keys billing binds for usage accounting (thin MVP). */
export const BILLING_USAGE_BINDINGS = Object.keys(USAGE_MAP);

/**
 * I1a (E3-04): billing consumer of relevant CRM/automation/document facts. For
 * each mapped event it calls the idempotent {@link ModuleSubscriptionService.incrementUsage}
 * (dedup by `idempotencyKey ?? messageId`, NFR-BILL-4 / RFC-4 §Р-4).
 */
@Injectable()
export class UsageConsumerService implements OnModuleInit {
  private readonly logger = new Logger(UsageConsumerService.name);

  constructor(
    private readonly modules: ModuleSubscriptionService,
    private readonly rabbit: RabbitMqService,
  ) {}

  async onModuleInit(): Promise<void> {
    if (process.env.BILLING_CONSUMER_DISABLED === 'true') {
      this.logger.warn('billing usage consumer disabled by env');
      return;
    }
    try {
      await this.rabbit.consume(
        process.env.BILLING_USAGE_QUEUE ?? busQueueName('billing.usage'),
        BILLING_USAGE_BINDINGS,
        (envelope) => this.handle(envelope),
      );
      this.logger.log(`billing usage consumer bound: ${BILLING_USAGE_BINDINGS.join(', ')}`);
    } catch (err) {
      // Broker may be down in some local setups; don't crash the domain.
      this.logger.error(`failed to start usage consumer: ${String(err)}`);
    }
  }

  async handle(envelope: EventEnvelope): Promise<void> {
    const type = String(envelope?.type ?? '');
    const mapping = USAGE_MAP[type];
    if (!mapping) return;

    const projectId = String(envelope.projectId ?? '');
    if (!projectId) return;

    const messageId = String(envelope.idempotencyKey ?? envelope.messageId ?? '');
    if (!messageId) return;

    await this.modules.incrementUsage({
      projectId,
      module: mapping.module,
      metric: mapping.metric,
      delta: 1,
      messageId,
    });
  }
}
