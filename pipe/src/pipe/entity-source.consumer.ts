import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import type { EventEnvelope } from '@fairflow/shared';
import { busQueueName } from '@fairflow/shared';
import { MongoService } from '../mongo/mongo.service';
import { RabbitMqConsumer } from '../messaging/rabbitmq.consumer';

export const PRODUCT_DELETED_KEY = 'crm.product.deleted';
export const CONTACT_DELETED_KEY = 'crm.contact.deleted';
export const COMPANY_DELETED_KEY = 'crm.company.deleted';

const ENTITY_SOURCE_KEYS = [PRODUCT_DELETED_KEY, CONTACT_DELETED_KEY, COMPANY_DELETED_KEY] as const;

function str(v: unknown): string {
  return typeof v === 'string' ? v : v == null ? '' : String(v);
}

/**
 * FR-DEALS-490 / FR-DEALS-500: react to donor lifecycle events that affect linked
 * deals — product hard-delete clears `productId` (keeps `productName`), contact/
 * company soft-delete marks the source as deleted while preserving snapshots.
 */
@Injectable()
export class EntitySourceConsumerService implements OnModuleInit {
  private readonly logger = new Logger(EntitySourceConsumerService.name);
  private readonly enabled = process.env.PIPE_ENTITY_SOURCE_CONSUMER_ENABLED !== 'false';

  constructor(
    private readonly mongo: MongoService,
    private readonly rabbit: RabbitMqConsumer,
  ) {}

  async onModuleInit(): Promise<void> {
    if (!this.enabled) {
      this.logger.log('pipe entity-source consumer disabled');
      return;
    }
    const queue = process.env.PIPE_ENTITY_SOURCE_QUEUE ?? busQueueName('pipe.entity-source');
    try {
      await this.rabbit.consume(
        queue,
        [...ENTITY_SOURCE_KEYS],
        (payload, routingKey) => this.handle(payload, routingKey),
        Number(process.env.PIPE_ENTITY_SOURCE_SUBSCRIBE_RETRIES ?? 10),
      );
      this.logger.log(`entity-source consumer bound queue=${queue}`);
    } catch (err) {
      this.logger.error(`entity-source consumer bind failed: ${String(err)}`);
    }
  }

  private async handle(payload: Record<string, unknown>, routingKey: string): Promise<void> {
    const env = payload as unknown as EventEnvelope<Record<string, unknown>>;
    const projectId = str(env.projectId);
    if (!projectId) {
      this.logger.warn(`${routingKey} without projectId — skipped`);
      return;
    }
    const p = (env.payload ?? {}) as Record<string, unknown>;
    const now = Date.now();

    if (routingKey === PRODUCT_DELETED_KEY) {
      const productId = str(p.id ?? p.productId);
      if (!productId) return;
      const res = await this.mongo
        .deals()
        .updateMany({ projectId, productId }, { $set: { productId: '', updatedAt: now } });
      if (res.modifiedCount) {
        this.logger.log(
          `product.deleted: cleared productId on ${res.modifiedCount} deal(s) (${projectId})`,
        );
      }
      return;
    }

    if (routingKey === CONTACT_DELETED_KEY) {
      const contactId = str(p.contactId ?? env.subject?.split('/').pop());
      if (!contactId) return;
      const res = await this.mongo
        .deals()
        .updateMany(
          { projectId, contactId },
          { $set: { contactSourceDeleted: true, updatedAt: now } },
        );
      if (res.modifiedCount) {
        this.logger.log(`contact.deleted: marked ${res.modifiedCount} deal(s) (${projectId})`);
      }
      return;
    }

    if (routingKey === COMPANY_DELETED_KEY) {
      const companyId = str(p.companyId ?? env.subject?.split('/').pop());
      if (!companyId) return;
      const res = await this.mongo
        .deals()
        .updateMany(
          { projectId, companyId },
          { $set: { companySourceDeleted: true, updatedAt: now } },
        );
      if (res.modifiedCount) {
        this.logger.log(`company.deleted: marked ${res.modifiedCount} deal(s) (${projectId})`);
      }
    }
  }
}
