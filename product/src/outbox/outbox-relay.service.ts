import { Injectable, Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { OutboxRelay } from '@fairflow/shared';
import { MongoOutboxStore } from './mongo-outbox.store';
import { RabbitMqPublisher } from './rabbitmq.publisher';

/**
 * Background relay loop (E3-01 / I1b): polls the Mongo outbox (`crm_event_outbox`)
 * for `pending` rows and publishes them to RabbitMQ at-least-once. Self-healing —
 * broker/Mongo hiccups just leave rows `pending` for the next tick.
 *
 * Disable with `OUTBOX_RELAY_ENABLED=false` (e.g. tests / read-only replicas).
 */
@Injectable()
export class OutboxRelayService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(OutboxRelayService.name);
  private readonly relay: OutboxRelay;
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private readonly enabled = process.env.OUTBOX_RELAY_ENABLED !== 'false';

  constructor(store: MongoOutboxStore, publisher: RabbitMqPublisher) {
    this.relay = new OutboxRelay(store, publisher);
  }

  onModuleInit(): void {
    if (!this.enabled) {
      this.logger.warn('Outbox relay disabled (OUTBOX_RELAY_ENABLED=false)');
      return;
    }
    this.schedule();
  }

  private schedule(): void {
    this.timer = setTimeout(() => void this.runOnce(), this.relay.pollIntervalMs);
  }

  private async runOnce(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const result = await this.relay.tick();
      if (result.published > 0 || result.failed > 0) {
        this.logger.log(
          `outbox tick: fetched=${result.fetched} published=${result.published} failed=${result.failed}`,
        );
      }
    } catch (err) {
      this.logger.error(
        `outbox relay tick failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      this.running = false;
      if (this.enabled) this.schedule();
    }
  }

  onModuleDestroy(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }
}
