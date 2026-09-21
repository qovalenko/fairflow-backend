import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ActivityService } from './activity.service';

/**
 * FR-ACTIVITIES-310: periodic scanner that finds overdue activities and publishes
 * `crm.activity.overdue` (once per row, via `claimOverdueNotification`).
 *
 * Disabled in unit/CI via `ACTIVITY_OVERDUE_SCANNER_ENABLED=false`.
 */
@Injectable()
export class OverdueScannerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(OverdueScannerService.name);
  private timer: NodeJS.Timeout | null = null;

  private readonly enabled = (process.env.ACTIVITY_OVERDUE_SCANNER_ENABLED ?? 'true') !== 'false';
  private readonly intervalMs = Number(process.env.ACTIVITY_OVERDUE_SCAN_INTERVAL_MS ?? 60_000);
  private readonly batchSize = Number(process.env.ACTIVITY_OVERDUE_SCAN_BATCH ?? 100);

  constructor(private readonly activity: ActivityService) {}

  onModuleInit(): void {
    if (!this.enabled) {
      this.logger.log('overdue scanner disabled (ACTIVITY_OVERDUE_SCANNER_ENABLED=false)');
      return;
    }
    this.timer = setInterval(() => {
      void this.sweep();
    }, this.intervalMs);
    this.timer.unref?.();
    this.logger.log(
      `overdue scanner started (every ${this.intervalMs}ms, batch ${this.batchSize})`,
    );
    void this.sweep();
  }

  async sweep(): Promise<{ published: number }> {
    let published = 0;
    try {
      const candidates = await this.activity.findOverdueCandidates(this.batchSize);
      for (const doc of candidates) {
        if (await this.activity.publishOverdueEvent(doc)) published++;
      }
      if (published > 0) {
        this.logger.log(`overdue scanner published ${published} crm.activity.overdue event(s)`);
      }
    } catch (err) {
      this.logger.warn(`overdue scanner sweep failed: ${String(err)}`);
    }
    return { published };
  }

  onModuleDestroy(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}
