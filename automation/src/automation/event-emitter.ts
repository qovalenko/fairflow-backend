import { buildOutboxRow, type EmitIntent } from '@fairflow/shared';
import type { RabbitMqService } from '../messaging/rabbitmq.service';

const AUTOMATION_SOURCE = 'automation';

/** Build and publish a canonical EventEnvelope for automation domain facts. */
export async function emitAutomationEvent(
  rabbit: RabbitMqService,
  intent: Omit<EmitIntent, 'source'>,
): Promise<void> {
  const row = buildOutboxRow({ ...intent, source: AUTOMATION_SOURCE });
  await rabbit.publishEnvelope(row.envelope);
}
