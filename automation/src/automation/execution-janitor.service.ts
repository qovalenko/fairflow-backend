import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { AutomationService } from './automation.service';

/**
 * Execution janitor (FR-MAUT-15 recovery).
 *
 * Periodically sweeps automation executions stuck in `running` and re-drives
 * their dispatch via {@link AutomationService.reclaimStaleRunning}. Without this,
 * an execution claimed as `running` before dispatch (the exactly-once guard) that
 * never dispatched — because the process died / the broker message was lost —
 * would wedge forever: a redelivery hits the unique `idempotency_key`, looks like
 * a duplicate, and skips, so the rule never runs and the DLQ retry (only `failed`
 * rows) never sees it.
 *
 * Disabled where there's no store loop (unit/CI) via `AUTOMATION_JANITOR_ENABLED=false`.
 */
@Injectable()
export class ExecutionJanitorService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ExecutionJanitorService.name);
  private timer: NodeJS.Timeout | null = null;

  /** Consider a `running` row stale after this long without finishing. */
  private readonly staleAfterMs = Number(
    process.env.AUTOMATION_RUNNING_STALE_MS ?? 5 * 60 * 1000,
  );
  /** How often to sweep. */
  private readonly sweepIntervalMs = Number(
    process.env.AUTOMATION_JANITOR_INTERVAL_MS ?? 60 * 1000,
  );
  private readonly enabled =
    (process.env.AUTOMATION_JANITOR_ENABLED ?? 'true') !== 'false';

  constructor(private readonly automation: AutomationService) {}

  onModuleInit(): void {
    if (!this.enabled) {
      this.logger.warn('execution janitor disabled (AUTOMATION_JANITOR_ENABLED=false)');
      return;
    }
    this.timer = setInterval(() => {
      void this.sweep();
    }, this.sweepIntervalMs);
    // Do not keep the event loop alive purely for the janitor.
    this.timer.unref?.();
    this.logger.log(
      `execution janitor started (stale>${this.staleAfterMs}ms, every ${this.sweepIntervalMs}ms)`,
    );
  }

  private async sweep(): Promise<void> {
    try {
      await this.automation.reclaimStaleRunning(this.staleAfterMs);
    } catch (error) {
      // Never let a sweep failure crash the interval — log and try next tick.
      this.logger.warn(`execution janitor sweep failed: ${String(error)}`);
    }
  }

  onModuleDestroy(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}
