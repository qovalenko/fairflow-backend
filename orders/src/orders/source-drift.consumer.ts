import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { busQueueName, type EventEnvelope } from '@fairflow/shared';
import { OrdersService } from './orders.service';
import { RabbitMqConsumer } from '../messaging/rabbitmq.consumer';

/** Donor requisite changes that can put an order snapshot out of date (RFC-4 §Р-3). */
export const SOURCE_DRIFT_KEYS = [
  'crm.contact.updated',
  'crm.contact.deleted',
  'crm.company.updated',
  'crm.company.deleted',
] as const;

/** Terminal outcome of one delivery (exposed for unit tests). */
export type SourceDriftOutcome = 'marked' | 'skipped' | 'dead_letter';

/**
 * Consumer of `crm.contact.*` / `crm.company.*` (FR-ORDERS-390, TODO-213).
 *
 * The order carries a point-in-time snapshot of the linked contact/company
 * requisites; when the donor changes, the snapshot silently goes stale. Before
 * this consumer `hasDrift` was only ever written as `false`, so the card banner
 * and the terminal-transition gate — both driven by that stored flag — could
 * never fire: the drift was only visible to someone who explicitly called
 * CheckDrift, and the UI only calls it when `hasDrift` is already true.
 *
 * The consumer re-reads the changed donor once and raises `hasDrift` on the open
 * orders of that project whose snapshot actually diverges (a change to a field
 * outside the compared requisites raises nothing). It never lowers the flag.
 *
 * Isolation: the scan filter is `{ projectId, contactId|companyId }` taken from
 * the envelope — never a body-supplied project. Idempotent: a redelivery finds
 * the orders already flagged and marks nothing. A poison message (no projectId /
 * no entity id) is terminal; an unreadable donor or a Mongo error throws → the
 * bounded retry ladder, then the DLQ.
 */
@Injectable()
export class SourceDriftConsumer implements OnModuleInit {
  private readonly logger = new Logger(SourceDriftConsumer.name);
  private readonly enabled = process.env.SOURCE_DRIFT_CONSUMER_ENABLED !== 'false';

  constructor(
    private readonly orders: OrdersService,
    private readonly rabbit: RabbitMqConsumer,
  ) {}

  async onModuleInit(): Promise<void> {
    if (!this.enabled) {
      this.logger.log('source-drift consumer disabled (SOURCE_DRIFT_CONSUMER_ENABLED=false)');
      return;
    }
    const queue = busQueueName('orders.source-drift');
    try {
      await this.rabbit.consume(
        queue,
        [...SOURCE_DRIFT_KEYS],
        async (payload, routingKey) => {
          await this.handle(payload, routingKey);
        },
        Number(process.env.SOURCE_DRIFT_SUBSCRIBE_RETRIES ?? 10),
      );
      this.logger.log(`source-drift consumer bound queue=${queue} to ${SOURCE_DRIFT_KEYS.join()}`);
    } catch (err) {
      this.logger.error(
        `source-drift consumer failed to bind; reconnect loop will keep trying: ${String(err)}`,
      );
    }
  }

  /**
   * Mark the orders whose snapshot diverges from the changed donor. Throws on an
   * unreadable donor / Mongo error (→ retry ladder); returns `dead_letter` for a
   * poison message.
   */
  async handle(payload: Record<string, unknown>, routingKey: string): Promise<SourceDriftOutcome> {
    const env = payload as unknown as EventEnvelope<Record<string, unknown>>;
    const projectId = typeof env.projectId === 'string' ? env.projectId.trim() : '';
    const entity: 'contact' | 'company' = routingKey.startsWith('crm.company.')
      ? 'company'
      : 'contact';
    const body = (env.payload ?? {}) as Record<string, unknown>;
    const raw = entity === 'contact' ? body.contactId : body.companyId;
    // `subject` is the canonical `<entity>/<id>` envelope address — used as the
    // fallback when a producer ships a payload without the flat id.
    const fromSubject =
      typeof env.subject === 'string' && env.subject.includes('/')
        ? env.subject.slice(env.subject.indexOf('/') + 1)
        : '';
    const entityId = (typeof raw === 'string' && raw.trim() ? raw.trim() : fromSubject).trim();
    if (!projectId || !entityId) {
      this.logger.error(`${routingKey} missing projectId/entityId — dead-lettering poison message`);
      return 'dead_letter';
    }
    const { scanned, marked } = await this.orders.markSourceDrift(projectId, entity, entityId);
    if (marked) {
      this.logger.log(
        `source drift project=${projectId} ${entity}=${entityId}: marked ${marked}/${scanned} order(s)`,
      );
    }
    return marked > 0 ? 'marked' : 'skipped';
  }
}
