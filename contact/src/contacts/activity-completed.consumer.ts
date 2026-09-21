import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { busQueueName, type EventEnvelope } from '@fairflow/shared';
import { ContactsService } from './contacts.service';
import { RabbitMqConsumer } from '../messaging/rabbitmq.consumer';

export const ACTIVITY_COMPLETED_KEY = 'crm.activity.completed';

/** Activity events carry the contact in `links[]`, not a top-level contactId. */
export function contactIdFromActivityPayload(body: Record<string, unknown>): string {
  if (typeof body.contactId === 'string' && body.contactId.trim()) return body.contactId.trim();
  if (typeof body.contact_id === 'string' && body.contact_id.trim()) return body.contact_id.trim();
  const links = Array.isArray(body.links) ? body.links : [];
  for (const raw of links) {
    if (!raw || typeof raw !== 'object') continue;
    const link = raw as Record<string, unknown>;
    const type = String(link.entityType ?? link.entity_type ?? '');
    const id = String(link.entityId ?? link.entity_id ?? '').trim();
    if (type === 'contact' && id) return id;
  }
  return '';
}

@Injectable()
export class ActivityCompletedConsumer implements OnModuleInit {
  private readonly logger = new Logger(ActivityCompletedConsumer.name);

  constructor(
    private readonly contacts: ContactsService,
    private readonly rabbit: RabbitMqConsumer,
  ) {}

  async onModuleInit(): Promise<void> {
    const queue = busQueueName('contact.activity-completed');
    try {
      await this.rabbit.consume(
        queue,
        [ACTIVITY_COMPLETED_KEY],
        async (payload) => {
          await this.handle(payload);
        },
        Number(process.env.ACTIVITY_COMPLETED_SUBSCRIBE_RETRIES ?? 10),
      );
      this.logger.log(`activity-completed consumer bound queue=${queue}`);
    } catch (err) {
      this.logger.error(`activity-completed consumer bind failed: ${String(err)}`);
    }
  }

  async handle(payload: Record<string, unknown>): Promise<void> {
    const env = payload as unknown as EventEnvelope<Record<string, unknown>>;
    const projectId = typeof env.projectId === 'string' ? env.projectId.trim() : '';
    const body = (env.payload ?? {}) as Record<string, unknown>;
    const contactId = contactIdFromActivityPayload(body);
    const completedAt = Number(body.completedAt ?? body.completed_at ?? env.timestamp ?? 0);
    if (!projectId || !contactId || !completedAt) return;
    await this.contacts.touchLastActivity(projectId, contactId, completedAt);
  }
}
