import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { busQueueName, type EventEnvelope } from '@fairflow/shared';
import { ActivityService } from './activity.service';
import { RabbitMqConsumer } from '../messaging/rabbitmq.consumer';

/** Map bus routing-key → linked entity type + payload id fields (FR-ACTIVITIES-250). */
const LINK_DRIFT_SOURCES: Record<
  string,
  { entityType: string; idFields: string[]; mode: 'refresh' | 'orphan' }
> = {
  'crm.contact.updated': { entityType: 'contact', idFields: ['contactId', 'id'], mode: 'refresh' },
  'crm.contact.deleted': { entityType: 'contact', idFields: ['contactId', 'id'], mode: 'orphan' },
  'crm.company.updated': { entityType: 'company', idFields: ['companyId', 'id'], mode: 'refresh' },
  'crm.company.deleted': { entityType: 'company', idFields: ['companyId', 'id'], mode: 'orphan' },
  'crm.deal.updated': { entityType: 'deal', idFields: ['dealId', 'id'], mode: 'refresh' },
  'crm.deal.deleted': { entityType: 'deal', idFields: ['dealId', 'id'], mode: 'orphan' },
  'crm.order.updated': { entityType: 'order', idFields: ['orderId', 'id'], mode: 'refresh' },
  'crm.order.deleted': { entityType: 'order', idFields: ['orderId', 'id'], mode: 'orphan' },
};

export const LINK_DRIFT_ROUTING_KEYS = Object.keys(LINK_DRIFT_SOURCES);

function str(v: unknown): string {
  return typeof v === 'string' ? v : v == null ? '' : String(v);
}

/**
 * FR-ACTIVITIES-250: keep activity `links[].nameSnapshot` / `orphaned` in sync when
 * linked CRM entities are updated or removed.
 */
@Injectable()
export class LinkDriftConsumer implements OnModuleInit {
  private readonly logger = new Logger(LinkDriftConsumer.name);
  private readonly enabled = process.env.ACTIVITY_LINK_DRIFT_CONSUMER_ENABLED !== 'false';

  constructor(
    private readonly activity: ActivityService,
    private readonly rabbit: RabbitMqConsumer,
  ) {}

  async onModuleInit(): Promise<void> {
    if (!this.enabled) {
      this.logger.log('link-drift consumer disabled (ACTIVITY_LINK_DRIFT_CONSUMER_ENABLED=false)');
      return;
    }
    const queue = busQueueName('activity.link-drift');
    try {
      await this.rabbit.consume(
        queue,
        LINK_DRIFT_ROUTING_KEYS,
        async (payload, routingKey) => {
          await this.handle(payload, routingKey);
        },
        Number(process.env.ACTIVITY_LINK_DRIFT_SUBSCRIBE_RETRIES ?? 10),
      );
      this.logger.log(
        `link-drift consumer bound queue=${queue} to ${LINK_DRIFT_ROUTING_KEYS.length} keys`,
      );
    } catch (err) {
      this.logger.error(`link-drift consumer failed to bind: ${String(err)}`);
    }
  }

  async handle(payload: Record<string, unknown>, routingKey: string): Promise<{ updated: number }> {
    const map = LINK_DRIFT_SOURCES[routingKey];
    if (!map) return { updated: 0 };
    const env = payload as unknown as EventEnvelope<Record<string, unknown>>;
    const projectId = str(env.projectId);
    if (!projectId) {
      this.logger.warn(`link-drift ${routingKey} without projectId — skipped`);
      return { updated: 0 };
    }
    const body = (env.payload ?? {}) as Record<string, unknown>;
    const subject = str(env.subject);
    const subjectId = subject.includes('/') ? subject.split('/', 2)[1] : '';
    let entityId = subjectId;
    for (const field of map.idFields) {
      if (entityId) break;
      entityId = str(body[field]);
    }
    if (!entityId) {
      this.logger.debug(`link-drift ${routingKey} without entity id — skipped`);
      return { updated: 0 };
    }
    const { updated } = await this.activity.syncLinksForEntity(
      projectId,
      map.entityType,
      entityId,
      map.mode,
    );
    if (updated > 0) {
      this.logger.debug(
        `link-drift ${routingKey} ${map.entityType}/${entityId}: updated ${updated} activity row(s)`,
      );
    }
    return { updated };
  }
}
