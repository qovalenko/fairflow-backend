import { Injectable } from '@nestjs/common';
import type { EventEnvelope } from '@fairflow/shared';
import { RabbitMqService } from '../messaging/rabbitmq.service';

/** Outbox relay publisher — delegates to automation RabbitMqService. */
@Injectable()
export class AutomationOutboxPublisher {
  constructor(private readonly rabbit: RabbitMqService) {}

  async publish(envelope: EventEnvelope): Promise<void> {
    await this.rabbit.publishEnvelope(envelope);
  }
}
