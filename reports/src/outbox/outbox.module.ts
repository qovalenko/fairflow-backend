import { Global, Module } from '@nestjs/common';
import { MongoModule } from '../mongo/mongo.module';
import { MongoOutboxStore } from './mongo-outbox.store';
import { RabbitMqPublisher } from './rabbitmq.publisher';
import { OutboxRelayService } from './outbox-relay.service';

/**
 * Transactional outbox for reports (E3-01 reference impl, RFC-4 §Р-4).
 * Exposes {@link MongoOutboxStore} so the reports service can `enqueue` a
 * `report.*` event row; the relay publishes pending rows to RabbitMQ.
 */
@Global()
@Module({
  imports: [MongoModule],
  providers: [MongoOutboxStore, RabbitMqPublisher, OutboxRelayService],
  exports: [MongoOutboxStore],
})
export class OutboxModule {}
