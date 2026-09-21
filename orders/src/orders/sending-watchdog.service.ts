import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { OrdersService } from './orders.service';

/**
 * SENDING watchdog (review MAJOR — operational exit from SENDING).
 *
 * Periodically sweeps orders stuck in `SENDING` longer than the stale budget and
 * expires them into `SEND_ERROR` via {@link OrdersService.expireStaleSending}.
 * Without it, any lost leg of the final-action saga — the request message never
 * consumed, the automation process dying between its claim and the answer, the
 * transport DLQ ladder exhausted, or the answer message lost — leaves the order
 * in SENDING forever (it is deliberately not cancellable, FR-MORD-29), with no
 * way out short of manual DB surgery. The watchdog guarantees the invariant
 * "SENDING always resolves": no answer within the budget ⇒ SEND_ERROR with a
 * readable lastError, from which RetryFinalAction (fresh `sendGen` key) resends.
 *
 * The stale budget MUST exceed the automation delivery worst case: 4 deliveries
 * over the bounded retry ladder (30s → 60s → 300s ≈ 6.5 min) plus per-delivery
 * execution timeouts. The 15-minute default leaves ample headroom; a genuinely
 * late success answer after expiry is skipped by the conditional transition in
 * orders (the order already left SENDING) — at-least-once semantics, surfaced
 * as a retryable SEND_ERROR instead of a silent wedge.
 *
 * Modeled on the automation `ExecutionJanitorService`; disabled where there is
 * no store loop (unit/CI) via `ORDERS_SENDING_WATCHDOG_ENABLED=false`.
 */
@Injectable()
export class SendingWatchdogService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(SendingWatchdogService.name);
  private timer: NodeJS.Timeout | null = null;

  /** Consider a SENDING order stale after this long without a saga answer. */
  private readonly staleAfterMs = Number(process.env.ORDERS_SENDING_STALE_MS ?? 15 * 60 * 1000);
  /** How often to sweep. */
  private readonly sweepIntervalMs = Number(
    process.env.ORDERS_SENDING_SWEEP_INTERVAL_MS ?? 60 * 1000,
  );
  private readonly enabled = (process.env.ORDERS_SENDING_WATCHDOG_ENABLED ?? 'true') !== 'false';

  constructor(private readonly orders: OrdersService) {}

  onModuleInit(): void {
    if (!this.enabled) {
      this.logger.warn('sending watchdog disabled (ORDERS_SENDING_WATCHDOG_ENABLED=false)');
      return;
    }
    this.timer = setInterval(() => {
      void this.sweep();
    }, this.sweepIntervalMs);
    // Do not keep the event loop alive purely for the watchdog.
    this.timer.unref?.();
    this.logger.log(
      `sending watchdog started (stale>${this.staleAfterMs}ms, every ${this.sweepIntervalMs}ms)`,
    );
  }

  /** One sweep tick (exposed for unit tests). */
  async sweep(): Promise<void> {
    try {
      await this.orders.expireStaleSending(this.staleAfterMs);
    } catch (error) {
      // Never let a sweep failure crash the interval — log and try next tick.
      this.logger.warn(`sending watchdog sweep failed: ${String(error)}`);
    }
  }

  onModuleDestroy(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}
