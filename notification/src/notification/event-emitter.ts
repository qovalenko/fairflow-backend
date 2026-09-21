import { buildOutboxRow, type EmitIntent } from '@fairflow/shared';
import type { RabbitMqService } from '../messaging/rabbitmq.service';

const NOTIFICATION_SOURCE = 'notification';

/** Build and publish a canonical EventEnvelope for notification domain facts. */
export async function emitNotificationEvent(
  rabbit: RabbitMqService,
  intent: Omit<EmitIntent, 'source'>,
): Promise<void> {
  const row = buildOutboxRow({ ...intent, source: NOTIFICATION_SOURCE });
  await rabbit.publishEnvelope(row.envelope);
}
