import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { busQueueName, type EventEnvelope } from '@fairflow/shared';
import { MongoService } from '../mongo/mongo.service';
import { S3Service } from '../s3/s3.service';
import { DriftRabbitMqConsumer } from './rabbitmq-consumer.service';

/** Routing-key emitted by control when a project is hard-purged (RFC-4). */
export const PROJECT_PURGED_KEY = 'control.project.purged';

/** Terminal outcome of one purge delivery (exposed for unit tests). */
export type PurgeOutcome = 'purged' | 'dead_letter';

/**
 * Consumer of `control.project.purged` (RFC-4): drops every per-project document
 * of the documents domain (templates, revisions, groups, generated versions) on a
 * project hard-purge. NOT touched: `event_outbox` (events in flight).
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
    private readonly s3: S3Service,
    private readonly rabbit: DriftRabbitMqConsumer,
  ) {}

  async onModuleInit(): Promise<void> {
    if (!this.enabled) {
      this.logger.log('project-purge consumer disabled (PROJECT_PURGE_CONSUMERS_ENABLED=false)');
      return;
    }
    const queue = busQueueName('documents.project-purge');
    try {
      await this.rabbit.consume(queue, [PROJECT_PURGED_KEY], async (payload) => {
        await this.handle(payload);
      });
      this.logger.log(`project-purge consumer bound queue=${queue} to ${PROJECT_PURGED_KEY}`);
    } catch (err) {
      this.logger.error(`project-purge consumer failed to bind: ${String(err)}`);
      this.rabbit.scheduleReconnectAfterBindFailure();
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
    const collections: [string, () => import('mongodb').Collection][] = [
      ['templates', () => this.mongo.templates()],
      ['template_revisions', () => this.mongo.templateRevisions()],
      ['document_groups', () => this.mongo.documentGroups()],
      ['document_versions', () => this.mongo.documentVersions()],
    ];
    const deleted: Record<string, number> = {};
    for (const [name, coll] of collections) {
      const res = await coll().deleteMany({ projectId });
      deleted[name] = res.deletedCount ?? 0;
    }
    const s3Deleted = await this.s3.deleteProjectPrefix(projectId);
    this.logger.log(
      `purged project ${projectId}: ${Object.entries(deleted)
        .map(([k, v]) => `${k}=${v}`)
        .join(', ')}, s3_objects=${s3Deleted}`,
    );
    return 'purged';
  }
}
