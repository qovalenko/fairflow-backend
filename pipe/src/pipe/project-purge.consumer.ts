import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { busQueueName, type EventEnvelope } from '@fairflow/shared';
import { MongoService } from '../mongo/mongo.service';
import { RabbitMqConsumer } from '../messaging/rabbitmq.consumer';

/** Routing-key emitted by control when a project is hard-purged (control project-purge). */
export const PROJECT_PURGED_KEY = 'control.project.purged';

/**
 * Per-project collections dropped on purge — every one carries a `projectId`
 * field so the `{ projectId }` filter fully isolates the tenant.
 *
 * NOT included: `crm_drift_inbox` (keyed only by `messageId`, no projectId) and
 * any `*_outbox` collection (events in flight — never touched).
 */
const PURGE_COLLECTIONS = [
  'crm_pipelines',
  'crm_deal_sources',
  'crm_deals',
  'crm_lost_reasons',
  'crm_deal_stage_history',
] as const;

/** Terminal outcome of one purge delivery (exposed for unit tests). */
export type PurgeOutcome = 'purged' | 'dead_letter';

/**
 * Consumer of `control.project.purged` (RFC-4). On a project hard-purge it drops
 * every per-project document of the pipe domain so no orphaned CRM data survives.
 *
 * Isolation: the delete filter is `{ projectId }` from the envelope — a foreign
 * event can never touch another tenant's data.
 *
 * Idempotency is natural: a redelivery simply deletes 0 rows (the data is already
 * gone), so no dedup-inbox is needed.
 *
 * Failure handling: a Mongo error throws → the shared retry-ladder/DLQ topology of
 * {@link RabbitMqConsumer} retries with backoff and only dead-letters once the
 * budget is exhausted (never a silent drop). A poison message (missing projectId)
 * is terminal (`dead_letter`) — logged and acked, never retried forever.
 */
@Injectable()
export class ProjectPurgeConsumer implements OnModuleInit {
  private readonly logger = new Logger(ProjectPurgeConsumer.name);
  private readonly enabled = process.env.PROJECT_PURGE_CONSUMERS_ENABLED !== 'false';

  constructor(
    private readonly mongo: MongoService,
    private readonly rabbit: RabbitMqConsumer,
  ) {}

  async onModuleInit(): Promise<void> {
    if (!this.enabled) {
      this.logger.log('project-purge consumer disabled (PROJECT_PURGE_CONSUMERS_ENABLED=false)');
      return;
    }
    const queue = busQueueName('pipe.project-purge');
    try {
      await this.rabbit.consume(
        queue,
        [PROJECT_PURGED_KEY],
        async (payload) => {
          await this.handle(payload);
        },
        Number(process.env.PROJECT_PURGE_SUBSCRIBE_RETRIES ?? 10),
      );
      this.logger.log(`project-purge consumer bound queue=${queue} to ${PROJECT_PURGED_KEY}`);
    } catch (err) {
      this.logger.error(
        `project-purge consumer failed to bind; reconnect loop will keep trying: ${String(err)}`,
      );
    }
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
    const db = this.mongo.getDb();
    const deleted: Record<string, number> = {};
    for (const name of PURGE_COLLECTIONS) {
      const res = await db.collection(name).deleteMany({ projectId });
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
