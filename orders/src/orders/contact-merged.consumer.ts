import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { busQueueName, type EventEnvelope } from '@fairflow/shared';
import { OrdersService } from './orders.service';
import { RabbitMqConsumer } from '../messaging/rabbitmq.consumer';

/** Routing-key emitted by contact when two records are merged (FR-CONTACTS-210). */
export const CONTACT_MERGED_KEY = 'crm.contact.merged';

/** Terminal outcome of one delivery (exposed for unit tests). */
export type ContactMergedOutcome = 'rewritten' | 'skipped' | 'dead_letter';

/**
 * Consumer of `crm.contact.merged` (TODO-170): rewrites `contactId` on every
 * order in the project that still points at a merge-tombstone source contact.
 *
 * The contact domain marks the loser as `mergedInto=target` and expects
 * downstream domains to repoint their foreign keys — orders store `contactId`
 * directly and queries/drift scans filter on it, so a passive read-time redirect
 * would not fix list filters or the source-drift consumer.
 *
 * After the rewrite the moved orders keep the snapshot captured from the SOURCE
 * contact, and the merge emits no `crm.contact.updated` for the target — so the
 * TODO-213 drift consumer never fires for this change. The handler therefore
 * runs `markSourceDrift` on the target itself, lighting the card banner and the
 * terminal-transition gate where the snapshot actually diverges.
 *
 * Isolation: the rewrite filter is `{ projectId, contactId: sourceId }` taken
 * from the envelope — never a body-supplied project. Idempotent: a redelivery
 * finds nothing still on the source id but still re-runs the drift marking. A
 * poison message (no projectId / target / sources) is terminal; a Mongo error or
 * an unreadable target contact throws → retry ladder / DLQ.
 */
@Injectable()
export class ContactMergedConsumer implements OnModuleInit {
  private readonly logger = new Logger(ContactMergedConsumer.name);
  private readonly enabled = process.env.CONTACT_MERGED_CONSUMER_ENABLED !== 'false';

  constructor(
    private readonly orders: OrdersService,
    private readonly rabbit: RabbitMqConsumer,
  ) {}

  async onModuleInit(): Promise<void> {
    if (!this.enabled) {
      this.logger.log('contact-merged consumer disabled (CONTACT_MERGED_CONSUMER_ENABLED=false)');
      return;
    }
    const queue = busQueueName('orders.contact-merged');
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
   * Repoint orders from merged source contact(s) to the surviving target, then
   * drift-mark against the target's current requisites. Throws on Mongo error or
   * an unreadable target (→ retry ladder); returns `dead_letter` for poison.
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
    const { rewritten } = await this.orders.rewriteContactOnMerge(
      projectId,
      sourceContactIds,
      targetContactId,
      mergeKey,
    );
    // Unconditional (not gated on `rewritten`): a redelivery after a failed
    // marking finds 0 rows to rewrite but must still finish this step.
    const { marked } = await this.orders.markSourceDrift(projectId, 'contact', targetContactId);
    if (rewritten || marked) {
      this.logger.log(
        `contact merge project=${projectId} →${targetContactId}: rewrote ${rewritten} order(s), drift-marked ${marked}`,
      );
    }
    return rewritten > 0 ? 'rewritten' : 'skipped';
  }
}
