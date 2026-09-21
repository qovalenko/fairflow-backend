import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { busQueueName } from '@fairflow/shared';
import { MongoService } from '../mongo/mongo.service';
import {
  RabbitMqService,
  type ConsumeResult,
  type DeliveredEvent,
} from '../messaging/rabbitmq.service';
import { ProjectionApply } from './search-projection.apply';

// Re-export the projection mapper + write-port from their dedicated module so
// existing importers (search.module, search-delta.writer) keep one entry point.
// ProjectionApply now lives in ./search-projection.apply to break the
// definition-order TDZ that crashed boot (F1-search / R2).
export {
  ProjectionApply,
  SEARCH_DELTA_WRITER,
  type SearchDeltaWriter,
  type ProjectionDoc,
} from './search-projection.apply';

/**
 * Search projection — event delta consumer (E4-19, contract §5.2, RFC-4 §Р-4).
 *
 * Subscribes to the `crm.*` business facts emitted by the source domains (I1a:
 * contact / company / pipe / orders / activity via the E3-01 transactional
 * outbox) and maintains the derived `search_index` as a point delta:
 *
 *   crm.<entity>.created | .updated            → upsert (partial merge)
 *   crm.<entity>.deleted                       → tombstone (deletedAt set)
 *   crm.<entity>.purged                        → terminal erase (PII scrubbed)
 *   crm.deal.stage_changed | .reassigned       → upsert (subtitle/owner refresh)
 *   crm.<entity>.restored | .merge_reverted    → upsert (clear tombstone)
 *   crm.activity.completed                     → upsert (status refresh)
 *
 * This REPLACES the wave-3 scaffold which (a) had no real consumer, and (b)
 * historically ran a FULL reindex(projectId) on EVERY event — an O(N) DoS
 * amplifier (contract §3.3 [SEC], §5.2 [AS-IS-ДЕФЕКТ]). Here every event touches
 * exactly one index document.
 *
 * Invariants:
 *  - isolation: every write carries `projectId` from the envelope (single DB,
 *    predicate isolation — contract §1 [SEC-BLOCKER]); an event without
 *    `projectId` is dropped (cannot be safely scoped).
 *  - transport dedup: `idempotencyKey ?? messageId` (RFC-4 §Р-4) via the
 *    `search_event_dedup` ledger — duplicate deliveries are no-ops.
 *  - applicative ordering: a write applies only if `incoming.version >
 *    stored.version` (NFR-MSRCH-4); stale/out-of-order events are dropped.
 *
 * The actual Mongo writes (upsert/tombstone with version-guard + no-orphan
 * checks) reuse {@link SearchService.indexUpsert}/{@link SearchService.indexDelete}.
 */
@Injectable()
export class SearchProjectionService implements OnModuleInit {
  private readonly logger = new Logger(SearchProjectionService.name);
  private readonly queueName =
    process.env.SEARCH_PROJECTION_QUEUE ?? busQueueName('search.projection');
  private readonly dedupTtlSec = Number(
    process.env.SEARCH_DEDUP_TTL_SEC ?? 7 * 24 * 60 * 60,
  );
  /** Disable the consumer in environments without a broker (e.g. unit/CI). */
  private readonly enabled =
    (process.env.SEARCH_PROJECTION_ENABLED ?? 'true') !== 'false';

  /** RFC-4 routing-keys the search projection listens to (contract §5.2). */
  private static readonly ROUTING_KEYS: readonly string[] = [
    'crm.contact.created',
    'crm.contact.updated',
    'crm.contact.deleted',
    'crm.contact.restored',
    'crm.contact.merged',
    'crm.company.created',
    'crm.company.updated',
    'crm.company.deleted',
    'crm.company.restored',
    'crm.company.merged',
    'crm.company.merge_reverted',
    // «Удалить навсегда» (FR-COMPANIES-040): the source row is physically gone,
    // so the index row is scrubbed, not tombstoned — see ProjectionApply.isPurge.
    'crm.company.purged',
    'crm.deal.created',
    'crm.deal.updated',
    'crm.deal.deleted',
    'crm.deal.restored',
    'crm.deal.reopened',
    'crm.deal.stage_changed',
    'crm.deal.reassigned',
    'crm.order.created',
    'crm.order.updated',
    'crm.order.deleted',
    'crm.order.status_changed',
    'crm.product.created',
    'crm.product.updated',
    'crm.product.deleted',
    'crm.activity.created',
    'crm.activity.updated',
    'crm.activity.deleted',
    'crm.activity.restored',
    'crm.activity.completed',
  ];

  constructor(
    private readonly mongo: MongoService,
    private readonly rabbit: RabbitMqService,
    private readonly projectionApply: ProjectionApply,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.ensureDedupTtl();
    if (!this.enabled) {
      this.logger.warn('search projection consumer disabled (SEARCH_PROJECTION_ENABLED=false)');
      return;
    }
    await this.subscribeWithRetry();
  }

  /**
   * Bind the consumer with a bounded retry-loop: the broker may not be reachable
   * the instant search boots (ordering / restart). A boot outage must not crash
   * search (the gRPC read path still serves the existing index), so after the
   * retry budget we give up the boot attempt — the RabbitMqService's own reconnect
   * loop still re-establishes the consumer once the broker returns.
   */
  private async subscribeWithRetry(): Promise<void> {
    const maxAttempts = Number(process.env.SEARCH_SUBSCRIBE_RETRIES ?? 10);
    const delayMs = Number(process.env.SEARCH_SUBSCRIBE_RETRY_MS ?? 3000);
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        await this.rabbit.consumeEvents(
          this.queueName,
          [...SearchProjectionService.ROUTING_KEYS],
          (event) => this.handle(event),
        );
        return;
      } catch (error) {
        this.logger.error(
          `search projection failed to subscribe (attempt ${attempt}/${maxAttempts}): ${String(error)}`,
        );
        if (attempt < maxAttempts) {
          await new Promise((r) => setTimeout(r, delayMs));
        }
      }
    }
    this.logger.error(
      'search projection could not subscribe after retries; RabbitMqService reconnect will keep trying',
    );
  }

  /** TTL index so the dedup ledger self-prunes (keeps it bounded). */
  private async ensureDedupTtl(): Promise<void> {
    try {
      await this.mongo
        .searchEventDedup()
        .createIndex({ at: 1 }, { expireAfterSeconds: this.dedupTtlSec, name: 'ttl_at' });
    } catch {
      // Best-effort at boot; an existing/legacy index must not crash the service.
    }
  }

  /**
   * Project one delivered event. Returns the broker outcome:
   *  - `ack` on success, on a duplicate, or on a permanently-undeliverable event
   *    (missing scope / unknown key) — nothing to retry;
   *  - throwing propagates to the consumer which dead-letters (transient store
   *    failures get retried via broker redelivery).
   */
  private async handle(event: DeliveredEvent): Promise<ConsumeResult> {
    const { routingKey, envelope } = event;
    const projectId = envelope.projectId;
    if (!projectId) {
      // Cannot be safely scoped → drop (never write cross-project, contract §1).
      this.logger.warn(`drop ${routingKey} ${envelope.messageId}: no projectId`);
      return 'ack';
    }

    // Transport dedup (RFC-4 §Р-4): claim the dedup key before applying.
    const dedupId = `${projectId}:${envelope.idempotencyKey ?? envelope.messageId}`;
    const claimed = await this.claimDedup(dedupId);
    if (!claimed) {
      return 'ack'; // already processed — idempotent no-op.
    }

    // claim-then-fail guard: if `apply` throws we MUST release the just-inserted
    // dedup row before propagating. Otherwise the throw → nack → redelivery would
    // hit the claim again, `claimDedup` would return false (looks like a dup), and
    // the message would be ack-ed with the index update silently lost forever.
    let applied: Awaited<ReturnType<ProjectionApply['apply']>>;
    try {
      applied = await this.projectionApply.apply(routingKey, projectId, envelope);
    } catch (error) {
      await this.releaseDedup(dedupId);
      throw error;
    }

    // Advance the per-project freshness watermark for GET /status (FR-MSRCH-29).
    await this.recordProcessed(projectId, envelope.messageId, envelope.timestamp);

    if (applied === 'unmapped') {
      // Bound key with no action (defensive) — ack so it doesn't pile up.
      this.logger.debug(`no-op for ${routingKey}`);
    }
    return 'ack';
  }

  /** Insert the dedup row; `false` if it already exists (duplicate delivery). */
  private async claimDedup(dedupId: string): Promise<boolean> {
    try {
      await this.mongo.searchEventDedup().insertOne({ _id: dedupId as never, at: new Date() });
      return true;
    } catch (e) {
      if ((e as { code?: number }).code === 11000) return false;
      throw e;
    }
  }

  /**
   * Release a claim whose `apply` failed so the broker redelivery can re-attempt
   * it (the claim is only meaningful once the projection actually applied). Best
   * effort: a failed delete leaves the row for the TTL sweeper, but the message
   * is still nack-ed/redelivered — no silent index loss.
   */
  private async releaseDedup(dedupId: string): Promise<void> {
    try {
      await this.mongo.searchEventDedup().deleteOne({ _id: dedupId as never });
    } catch (e) {
      this.logger.warn(`failed to release dedup claim ${dedupId}: ${String(e)}`);
    }
  }

  private async recordProcessed(
    projectId: string,
    messageId: string,
    timestamp: string,
  ): Promise<void> {
    const ts = Date.parse(timestamp) || Date.now();
    await this.mongo.searchIndexState().updateOne(
      { projectId },
      {
        $max: { lastEventProcessedAt: ts },
        $set: { lastMessageId: messageId, updatedAt: Date.now() },
      },
      { upsert: true },
    );
  }
}
