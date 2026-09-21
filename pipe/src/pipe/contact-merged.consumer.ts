import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { busQueueName, type EventEnvelope } from '@fairflow/shared';
import { PipeService } from './pipe.service';
import { RabbitMqConsumer } from '../messaging/rabbitmq.consumer';

/** Routing-key emitted by contact when two records are merged (FR-CONTACTS-210). */
export const CONTACT_MERGED_KEY = 'crm.contact.merged';

/** Terminal outcome of one delivery (exposed for unit tests). */
export type ContactMergedOutcome = 'rewritten' | 'skipped' | 'dead_letter';

/**
 * Consumer of `crm.contact.merged` (TODO-170): rewrites `contactId` on every
 * open deal in the project that still points at a merge-tombstone source contact.
 *
 * Deals store `contactId` directly and list/drift scans filter on it, so a
 * passive read-time redirect would not fix kanban filters or the drift consumer.
 * Each moved deal emits `crm.deal.updated` so search/denorm stay in sync.
 */
@Injectable()
export class ContactMergedConsumer implements OnModuleInit {
  private readonly logger = new Logger(ContactMergedConsumer.name);
  private readonly enabled = process.env.CONTACT_MERGED_CONSUMER_ENABLED !== 'false';

  constructor(
    private readonly pipe: PipeService,
    private readonly rabbit: RabbitMqConsumer,
  ) {}

  async onModuleInit(): Promise<void> {
    if (!this.enabled) {
      this.logger.log('contact-merged consumer disabled (CONTACT_MERGED_CONSUMER_ENABLED=false)');
      return;
    }
    const queue = busQueueName('pipe.contact-merged');
    try {
      await this.rabbit.consume(
        queue,
        [CONTACT_MERGED_KEY],
        async (payload) => {
          await this.handle(payload);
        },
        Number(process.env.CONTACT_MERGED_SUBSCRIBE_RETRIES ?? 10),
      );
      this.logger.log(`contact-merged consumer bound queue=${queue} to ${CONTACT_MERGED_KEY}`);
    } catch (err) {
      this.logger.error(
        `contact-merged consumer failed to bind; reconnect loop will keep trying: ${String(err)}`,
      );
    }
  }

  /**
   * Repoint deals from merged source contact(s) to the surviving target. Throws on
   * Mongo error (→ retry ladder); returns `dead_letter` for poison.
   */
  async handle(payload: Record<string, unknown>): Promise<ContactMergedOutcome> {
    const env = payload as unknown as EventEnvelope<Record<string, unknown>>;
    const projectId = typeof env.projectId === 'string' ? env.projectId.trim() : '';
    const body = (env.payload ?? {}) as Record<string, unknown>;
    const targetContactId =
      typeof body.targetContactId === 'string' ? body.targetContactId.trim() : '';
    const rawSources = body.sourceContactIds;
    const sourceContactIds = Array.isArray(rawSources)
      ? rawSources.filter((x): x is string => typeof x === 'string' && x.trim().length > 0)
      : [];
    const mergeKey =
      typeof env.idempotencyKey === 'string' && env.idempotencyKey.trim()
        ? env.idempotencyKey.trim()
        : `contact.merged:${sourceContactIds.join()}:${targetContactId}`;
    if (!projectId || !targetContactId || sourceContactIds.length === 0) {
      this.logger.error(
        'crm.contact.merged missing projectId/targetContactId/sourceContactIds — dead-lettering poison message',
      );
      return 'dead_letter';
    }
    const { rewritten } = await this.pipe.rewriteContactOnMerge(
      projectId,
      sourceContactIds,
      targetContactId,
      mergeKey,
    );
    if (rewritten > 0) {
      this.logger.log(
        `contact merge project=${projectId} →${targetContactId}: rewrote ${rewritten} deal(s)`,
      );
    }
    return rewritten > 0 ? 'rewritten' : 'skipped';
  }
}
