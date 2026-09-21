import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { busQueueName, type EventEnvelope } from '@fairflow/shared';
import { ActivityService } from './activity.service';
import { RabbitMqConsumer } from '../messaging/rabbitmq.consumer';

/** Routing-key emitted by contact when two records are merged (FR-CONTACTS-210). */
export const CONTACT_MERGED_KEY = 'crm.contact.merged';

/** Terminal outcome of one delivery (exposed for unit tests). */
export type ContactMergedOutcome = 'rewritten' | 'skipped' | 'dead_letter';

/**
 * Consumer of `crm.contact.merged` (TODO-170): rewrites contact links on every
 * activity in the project that still references a merge-tombstone source contact.
 *
 * Activities bind contacts through `links[]` (`entityType:'contact'`), not a flat
 * scalar — list filters and card tabs query `$elemMatch` on that array.
 */
@Injectable()
export class ContactMergedConsumer implements OnModuleInit {
  private readonly logger = new Logger(ContactMergedConsumer.name);
  private readonly enabled = process.env.CONTACT_MERGED_CONSUMER_ENABLED !== 'false';

  constructor(
    private readonly activity: ActivityService,
    private readonly rabbit: RabbitMqConsumer,
  ) {}

  async onModuleInit(): Promise<void> {
    if (!this.enabled) {
      this.logger.log('contact-merged consumer disabled (CONTACT_MERGED_CONSUMER_ENABLED=false)');
      return;
    }
    const queue = busQueueName('activity.contact-merged');
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
   * Repoint activity contact links from merged source(s) to the surviving target.
   * Throws on Mongo error (→ retry ladder); returns `dead_letter` for poison.
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
    const { rewritten } = await this.activity.rewriteContactLinksOnMerge(
      projectId,
      sourceContactIds,
      targetContactId,
      mergeKey,
    );
    if (rewritten > 0) {
      this.logger.log(
        `contact merge project=${projectId} →${targetContactId}: rewrote ${rewritten} activity link(s)`,
      );
    }
    return rewritten > 0 ? 'rewritten' : 'skipped';
  }
}
