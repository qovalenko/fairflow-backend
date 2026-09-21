import { Global, Module } from '@nestjs/common';
import { MongoModule } from '../mongo/mongo.module';
import { MongoOutboxStore } from './mongo-outbox.store';
import { RabbitMqPublisher } from './rabbitmq.publisher';
import { OutboxRelayService } from './outbox-relay.service';

/**
 * Transactional outbox (RFC-4 §Р-4). Exposes {@link MongoOutboxStore} so the
 * chat service can enqueue `chat.*` events in the same Mongo session as their
 * business write; the relay publishes pending rows after commit.
 */
@Global()
@Module({
  imports: [MongoModule],
  providers: [MongoOutboxStore, RabbitMqPublisher, OutboxRelayService],
  exports: [MongoOutboxStore],
})
export class OutboxModule {}
