import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { busQueueName, type EventEnvelope } from '@fairflow/shared';
import { DriftRabbitMqConsumer } from './rabbitmq-consumer.service';
import { DocumentsService } from '../documents/documents.service';

/** Routing-key emitted when contacts are merged (contact domain). */
export const CONTACT_MERGED_KEY = 'crm.contact.merged';

function str(v: unknown): string {
  return typeof v === 'string' ? v : v == null ? '' : String(v);
}

/**
 * Consumer of `crm.contact.merged`: re-points document groups/versions that were
 * bound to merged-away contact ids to the survivor contact id.
 */
@Injectable()
export class ContactMergedListener implements OnModuleInit {
  private readonly logger = new Logger(ContactMergedListener.name);
  private readonly enabled = process.env.DOCUMENTS_CONTACT_MERGE_LISTENER_ENABLED !== 'false';

  constructor(
    private readonly rabbit: DriftRabbitMqConsumer,
    private readonly documents: DocumentsService,
  ) {}

  async onModuleInit(): Promise<void> {
    if (!this.enabled) {
      this.logger.log(
        'contact-merge listener disabled (DOCUMENTS_CONTACT_MERGE_LISTENER_ENABLED=false)',
      );
      return;
    }
    const queue = busQueueName('documents.contact-merged');
    try {
      await this.rabbit.consume(queue, [CONTACT_MERGED_KEY], (payload) => this.handle(payload));
      this.logger.log(`contact-merge listener bound queue=${queue} to ${CONTACT_MERGED_KEY}`);
    } catch (err) {
      this.logger.error(`contact-merge listener failed to bind: ${String(err)}`);
      this.rabbit.scheduleReconnectAfterBindFailure();
    }
  }

  async handle(payload: Record<string, unknown>): Promise<void> {
    const env = payload as unknown as EventEnvelope<Record<string, unknown>>;
    const projectId = str(env.projectId);
    if (!projectId) {
      this.logger.warn('crm.contact.merged without projectId — skipped');
      return;
    }
    const body = (env.payload ?? {}) as Record<string, unknown>;
    const targetContactId = str(body.targetContactId);
    const sourceIds = Array.isArray(body.sourceContactIds)
      ? body.sourceContactIds.map((id) => str(id)).filter(Boolean)
      : [];
    if (!targetContactId || !sourceIds.length) {
      this.logger.debug('crm.contact.merged without source/target ids — skipped');
      return;
    }
    const { groups, versions } = await this.documents.reassignContactDocuments(
      projectId,
      sourceIds,
      targetContactId,
    );
    if (groups > 0 || versions > 0) {
      this.logger.log(
        `contact merged ${sourceIds.join(',')} → ${targetContactId}: groups=${groups} versions=${versions}`,
      );
    }
  }
}
