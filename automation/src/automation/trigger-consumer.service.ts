import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ROUTING_KEY_REGISTRY, busQueueName } from '@fairflow/shared';
import { RabbitMqService, type ConsumeDisposition } from '../messaging/rabbitmq.service';
import { AutomationService } from './automation.service';
import { TRIGGER_CATALOG } from './registry';

/**
 * Automation trigger consumer (contract §5 "Слушает", FR-MAUT-PRE-1).
 *
 * Boots the real event-triggered path: a durable queue bound to the `crm.*`
 * routing-keys that the in-code {@link TRIGGER_CATALOG} can react to (the keys
 * the CRM domains already emit — I1a). Each delivery is parsed by
 * {@link RabbitMqService.consumeEnvelope} into a canonical `EventEnvelope`
 * (transport dedup / lineage from the envelope, DLX on poison) and handed to
 * {@link AutomationService.consumeEvent}, which owns matching, dedup
 * (idempotency claim), anti-loop (depth) and freeze.
 *
 * Replaces the wave-3 skeleton consumer that bound to the non-existent
 * `automation.trigger` keys and parsed a raw payload.
 */
@Injectable()
export class TriggerConsumerService implements OnModuleInit {
  private readonly logger = new Logger(TriggerConsumerService.name);

  constructor(
    private readonly rabbit: RabbitMqService,
    private readonly automation: AutomationService,
  ) {}

  async onModuleInit(): Promise<void> {
    const queue =
      process.env.AUTOMATION_TRIGGER_QUEUE ?? busQueueName('automation.triggers');
    const routingKeys = this.triggerRoutingKeys();
    await this.subscribeWithRetry(queue, routingKeys);
  }

  /**
   * Bind the trigger consumer with a bounded retry-loop — the broker may not be
   * reachable the instant automation boots (ordering / restart). A boot outage
   * must not stop the gRPC API from coming up, so after the retry budget we give
   * up the boot attempt; the RabbitMqService's own reconnect loop still
   * re-establishes the consumer once the broker returns.
   */
  private async subscribeWithRetry(queue: string, routingKeys: string[]): Promise<void> {
    const maxAttempts = Number(process.env.AUTOMATION_SUBSCRIBE_RETRIES ?? 10);
    const delayMs = Number(process.env.AUTOMATION_SUBSCRIBE_RETRY_MS ?? 3000);
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        await this.rabbit.consumeEnvelope(queue, routingKeys, async (envelope) => {
          const disposition = await this.automation.consumeEvent(envelope);
          return disposition as ConsumeDisposition;
        });
        this.logger.log(
          `Automation trigger consumer bound queue=${queue} to ${routingKeys.length} crm.* keys`,
        );
        return;
      } catch (error) {
        this.logger.error(
          `Failed to start trigger consumer on ${queue} (attempt ${attempt}/${maxAttempts}): ${String(error)}`,
        );
        if (attempt < maxAttempts) {
          await new Promise((r) => setTimeout(r, delayMs));
        }
      }
    }
    this.logger.error(
      `Trigger consumer could not bind ${queue} after retries; RabbitMqService reconnect will keep trying`,
    );
  }

  /**
   * The set of `crm.*` routing-keys to bind. Derived from the trigger catalog
   * (the events automation can react to) intersected with the canonical routing
   * registry, so we never bind to an unregistered key.
   */
  private triggerRoutingKeys(): string[] {
    const registered = new Set(ROUTING_KEY_REGISTRY.map((e) => e.key));
    const keys = new Set<string>();
    for (const trigger of TRIGGER_CATALOG) {
      if (registered.has(trigger.eventName)) keys.add(trigger.eventName);
    }
    return [...keys];
  }
}
