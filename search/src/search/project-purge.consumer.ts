import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { busQueueName, type EventEnvelope } from '@fairflow/shared';
import { MongoService } from '../mongo/mongo.service';
import {
  RabbitMqService,
  type ConsumeResult,
  type DeliveredEvent,
} from '../messaging/rabbitmq.service';

/** Routing-key emitted by control when a project is hard-purged (RFC-4). */
export const PROJECT_PURGED_KEY = 'control.project.purged';

/** Terminal outcome of one purge delivery (exposed for unit tests). */
export type PurgeOutcome = 'purged' | 'dead_letter';

/**
 * Consumer of `control.project.purged` (RFC-4): on a project hard-purge it drops
 * the DERIVED SEARCH DATA of that project — `search_index` and
 * `search_index_state`. Without this the search index would keep serving stale
 * hits for a purged tenant.
 *
 * NOT touched (TODO-255): the CRM source collections (`crm_deals`, `crm_orders`,
 * `crm_products`, `crm_activities`, `contacts`, `companies`). They are owned by
 * their domains, not by search — search keeps no read-model copies of them, it
 * only READS them in the recovery reindex (SearchService.reindexSources). Purging
 * them from here destroyed another domain's data on a purge event and raced with
 * that domain's own purge consumer.
 *
 * NOT touched: `search_event_dedup` (keyed by `idempotencyKey ?? messageId`, not
 * projectId — a TTL prunes it).
 *
 * Isolation: every delete filter is `{ projectId }` from the envelope. Idempotency
 * is natural (a redelivery deletes 0 rows). A Mongo error throws → shared retry
 * ladder / DLQ; a poison message (no projectId) is terminal (`dead_letter`).
 */
@Injectable()
export class ProjectPurgeConsumer implements OnModuleInit {
  private readonly logger = new Logger(ProjectPurgeConsumer.name);
  private readonly enabled = process.env.PROJECT_PURGE_CONSUMERS_ENABLED !== 'false';

  constructor(
    private readonly mongo: MongoService,
    private readonly rabbit: RabbitMqService,
  ) {}

  async onModuleInit(): Promise<void> {
    if (!this.enabled) {
      this.logger.log('project-purge consumer disabled (PROJECT_PURGE_CONSUMERS_ENABLED=false)');
      return;
    }
    const queue = busQueueName('search.project-purge');
    try {
      await this.rabbit.consumeEvents(queue, [PROJECT_PURGED_KEY], (event) => this.onEvent(event));
      this.logger.log(`project-purge consumer bound queue=${queue} to ${PROJECT_PURGED_KEY}`);
    } catch (err) {
      this.logger.error(
        `project-purge consumer failed to bind; reconnect loop will keep trying: ${String(err)}`,
      );
    }
  }

  /** Bus adapter: map the purge outcome to the transport result (throwing = retry). */
  private async onEvent(event: DeliveredEvent): Promise<ConsumeResult> {
    // Both outcomes ack: a successful purge is done, a poison message is a terminal
    // drop (already logged as error) — neither should be requeued. A Mongo error
    // throws out of handle() and the RabbitMqService climbs the retry ladder.
    await this.handle(event.envelope as unknown as Record<string, unknown>);
    return 'ack';
  }

  /**
   * Drop every per-project document for the purged project. Throws on a Mongo
   * error (→ retry ladder / DLQ); returns `dead_letter` for a poison message.
   */
  async handle(payload: Record<string, unknown>): Promise<PurgeOutcome> {
    const env = payload as unknown as EventEnvelope<Record<string, unknown>>;
    const projectId = typeof env.projectId === 'string' ? env.projectId.trim() : '';
    if (!projectId) {
      this.logger.error('control.project.purged without projectId — dead-lettering poison message');
      return 'dead_letter';
    }
    // Search owns exactly these two collections — see the class doc (TODO-255).
    const collections: [string, () => import('mongodb').Collection][] = [
      ['search_index', () => this.mongo.searchIndex()],
      ['search_index_state', () => this.mongo.searchIndexState()],
    ];
    const deleted: Record<string, number> = {};
    for (const [name, coll] of collections) {
      const res = await coll().deleteMany({ projectId });
      deleted[name] = res.deletedCount ?? 0;
    }
    this.logger.log(
      `purged project ${projectId}: ${Object.entries(deleted)
        .map(([k, v]) => `${k}=${v}`)
        .join(', ')}`,
    );
    return 'purged';
  }
}
