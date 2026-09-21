import { Global, Module } from '@nestjs/common';
import { MongoModule } from '../mongo/mongo.module';
import { MongoOutboxStore } from './mongo-outbox.store';
import { RabbitMqPublisher } from './rabbitmq.publisher';
import { OutboxRelayService } from './outbox-relay.service';

/**
 * Transactional outbox (E3-01, RFC-4 §Р-4) for the orders domain.
 * Exposes {@link MongoOutboxStore} so {@link OrdersService} can `withOutbox` its
 * business write + event row in one Mongo session; the relay publishes pending
 * rows from `crm_event_outbox` to RabbitMQ.
 */
@Global()
@Module({
  imports: [MongoModule],
  providers: [MongoOutboxStore, RabbitMqPublisher, OutboxRelayService],
  exports: [MongoOutboxStore],
})
export class OutboxModule {}
