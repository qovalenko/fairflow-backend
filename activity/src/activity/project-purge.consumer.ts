import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { busQueueName, type EventEnvelope } from '@fairflow/shared';
import { MongoService } from '../mongo/mongo.service';
import { RabbitMqConsumer } from '../messaging/rabbitmq.consumer';

/** Routing-key emitted by control when a project is hard-purged (RFC-4). */
export const PROJECT_PURGED_KEY = 'control.project.purged';

/**
 * Per-project collections dropped on purge (all carry a `projectId`).
 * NOT included: `_outbox` (events in flight).
 */
const PURGE_COLLECTIONS = ['crm_activities'] as const;

/** Terminal outcome of one purge delivery (exposed for unit tests). */
export type PurgeOutcome = 'purged' | 'dead_letter';

/**
 * Consumer of `control.project.purged` (RFC-4): drops every per-project document
 * of the activity domain on a project hard-purge.
 *
 * Isolation: the delete filter is `{ projectId }` from the envelope. Idempotency
 * is natural (a redelivery deletes 0 rows). A Mongo error throws → shared retry
 * ladder / DLQ; a poison message (no projectId) is terminal (`dead_letter`).
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
    const queue = busQueueName('activity.project-purge');
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
