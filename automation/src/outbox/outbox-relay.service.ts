import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { OutboxRelay } from '@fairflow/shared';
import { AutomationMongoOutboxStore } from './mongo-outbox.store';
import { AutomationOutboxPublisher } from './automation-outbox.publisher';

/** Background relay for automation_event_outbox (FR-AUTOM-410). */
@Injectable()
export class AutomationOutboxRelayService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(AutomationOutboxRelayService.name);
  private readonly relay: OutboxRelay;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  private readonly enabled = process.env.AUTOMATION_OUTBOX_RELAY_ENABLED !== 'false';

  constructor(store: AutomationMongoOutboxStore, publisher: AutomationOutboxPublisher) {
    this.relay = new OutboxRelay(store, publisher, {
      batchSize: Number(process.env.AUTOMATION_OUTBOX_BATCH ?? 20) || 20,
      pollIntervalMs: Number(process.env.AUTOMATION_OUTBOX_POLL_MS ?? 5000) || 5000,
    });
  }

  onModuleInit(): void {
    if (!this.enabled) {
      this.logger.warn('Automation outbox relay disabled (AUTOMATION_OUTBOX_RELAY_ENABLED=false)');
      return;
    }
    this.schedule();
  }

  private schedule(): void {
    this.timer = setTimeout(() => void this.runOnce(), this.relay.pollIntervalMs);
    this.timer.unref?.();
  }

  private async runOnce(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const result = await this.relay.tick();
      if (result.published > 0 || result.failed > 0) {
        this.logger.log(
          `automation outbox tick: fetched=${result.fetched} published=${result.published} failed=${result.failed}`,
        );
      }
    } catch (err) {
      this.logger.error(
        `automation outbox relay failed: ${err instanceof Error ? err.message : String(err)}`,
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
