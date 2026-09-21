import { Global, Module } from '@nestjs/common';
import { RabbitMqConsumer } from './rabbitmq.consumer';

/**
 * Inbound-bus wiring for this domain. Exposes the generic
 * {@link RabbitMqConsumer} so domain consumers (project-purge, …) can bind a
 * durable work queue to `crm.*` routing-keys with the shared DLQ topology.
 * The outbox publisher keeps its own separate connection (OutboxModule).
 */
@Global()
@Module({
  providers: [RabbitMqConsumer],
  exports: [RabbitMqConsumer],
})
export class MessagingModule {}
