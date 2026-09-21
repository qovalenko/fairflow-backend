import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { OutboxRelay } from '@fairflow/shared';
import { ControlOutboxStore } from './control-outbox.store';
import { ControlRabbitMqPublisher } from './control-rabbitmq.publisher';

/**
 * P8 T5.2 (X-10): background relay that pumps pending control outbox rows to the
 * broker at-least-once (RFC-4 §Р-4). Wires the shared `OutboxRelay` loop over the
 * PG store + RabbitMQ publisher and ticks it on an interval.
 *
 * A broker outage only leaves rows `pending` (the publisher throws, the store
 * bumps `attempts`) — nothing is lost; the next tick retries. Disabled by
 * `CONTROL_OUTBOX_DISABLED=true` (tests / envs without a broker).
 */
@Injectable()
export class ControlOutboxRelayService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ControlOutboxRelayService.name);
  private readonly relay: OutboxRelay;
  private timer: ReturnType<typeof setInterval> | null = null;
  private ticking = false;
  private readonly disabled = process.env.CONTROL_OUTBOX_DISABLED === 'true';

  constructor(store: ControlOutboxStore, publisher: ControlRabbitMqPublisher) {
    this.relay = new OutboxRelay(store, publisher);
  }

  onModuleInit(): void {
    if (this.disabled) {
      this.logger.warn('control outbox relay disabled (CONTROL_OUTBOX_DISABLED=true)');
      return;
    }
    this.timer = setInterval(() => void this.runTick(), this.relay.pollIntervalMs);
    this.timer.unref?.();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** One relay tick; overlapping ticks are skipped (single in-flight batch). */
  private async runTick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      const result = await this.relay.tick();
      if (result.failed > 0) {
        this.logger.warn(`outbox relay: published=${result.published} failed=${result.failed}`);
      }
    } catch (error) {
      this.logger.warn(`outbox relay tick failed: ${String(error)}`);
    } finally {
      this.ticking = false;
    }
  }
}
