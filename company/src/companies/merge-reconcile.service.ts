import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { CompaniesService } from './companies.service';

const DEFAULT_INTERVAL_MS = 60_000;
const DEFAULT_ACK_WINDOW_MS = 15 * 60_000;
const DEFAULT_BATCH = 100;

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/**
 * TODO-154: the caller `reconcileMerge` never had. A merge parks the loser in
 * `mergeState: 'pending'` while contact/deal/order/activity re-stitch their references
 * off `crm.company.merged`; without a sweeper the record stayed `pending` forever and
 * the merge never reached a terminal state.
 *
 * In-domain background loop (mirrors {@link OutboxRelayService}) — deliberately not a
 * REST endpoint and not a cross-service call: domains expose business logic over gRPC
 * only (architecture invariant #1).
 *
 * The tick is idempotent and carries no idempotency key: `reconcileMerge` is a `$set`
 * to the terminal state, and a settled archive drops out of the `pending` query, so a
 * repeat (crash mid-batch, several replicas) can neither double-apply nor wedge a
 * record the way a replayed saga key once wedged an order in SENDING.
 *
 * Env: `MERGE_RECONCILE_ENABLED=false` disables it, `MERGE_RECONCILE_INTERVAL_MS`
 * (poll period), `MERGE_RECONCILE_ACK_WINDOW_MS` (grace given to consumers),
 * `MERGE_RECONCILE_BATCH` (rows per tick).
 */
@Injectable()
export class MergeReconcileService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(MergeReconcileService.name);
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private readonly enabled = process.env.MERGE_RECONCILE_ENABLED !== 'false';
  readonly intervalMs = envInt('MERGE_RECONCILE_INTERVAL_MS', DEFAULT_INTERVAL_MS);
  readonly ackWindowMs = envInt('MERGE_RECONCILE_ACK_WINDOW_MS', DEFAULT_ACK_WINDOW_MS);
  readonly batchSize = envInt('MERGE_RECONCILE_BATCH', DEFAULT_BATCH);

  constructor(private readonly companies: CompaniesService) {}

  onModuleInit(): void {
    if (!this.enabled) {
      this.logger.warn('Merge reconcile sweeper disabled (MERGE_RECONCILE_ENABLED=false)');
      return;
    }
    this.schedule();
  }

  onModuleDestroy(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private schedule(): void {
    this.timer = setTimeout(() => void this.runOnce(), this.intervalMs);
    // Never hold the process open just for the sweeper.
    this.timer.unref?.();
  }

  private async runOnce(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const res = await this.tick();
      if (res.settled > 0 || res.failed > 0) {
        this.logger.log(
          `merge reconcile tick: scanned=${res.scanned} settled=${res.settled} failed=${res.failed}`,
        );
      }
    } catch (err) {
      this.logger.error(
        `merge reconcile tick failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      this.running = false;
      if (this.enabled) this.schedule();
    }
  }

  /** One sweep: pending merges older than the ack window → settled. */
  async tick(
    now: Date = new Date(),
  ): Promise<{ scanned: number; settled: number; failed: number }> {
    const cutoff = new Date(now.getTime() - this.ackWindowMs);
    const pending = await this.companies.listPendingMerges(cutoff, this.batchSize);
    let settled = 0;
    let failed = 0;
    for (const row of pending) {
      try {
        await this.companies.reconcileMerge(row.projectId, row.loserId);
        settled++;
      } catch (err) {
        // A single bad row must not stop the sweep — it stays `pending` for the next tick.
        failed++;
        this.logger.warn(
          `merge reconcile failed for loser=${row.loserId} project=${row.projectId}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }
    return { scanned: pending.length, settled, failed };
  }
}
