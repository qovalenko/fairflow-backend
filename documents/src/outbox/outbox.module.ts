import { Global, Module } from '@nestjs/common';
import { MongoModule } from '../mongo/mongo.module';
import { MongoOutboxStore } from './mongo-outbox.store';
import { RabbitMqPublisher } from './rabbitmq.publisher';
import { OutboxRelayService } from './outbox-relay.service';

/**
 * Transactional outbox for the documents domain (E3-01 reference impl,
 * RFC-4 §Р-4). Exposes {@link MongoOutboxStore} so {@link DocumentsService} can
 * write `document.*` event rows in the same Mongo write as its mutation; the
 * relay publishes pending rows to RabbitMQ at-least-once.
 */
@Global()
@Module({
  imports: [MongoModule],
  providers: [MongoOutboxStore, RabbitMqPublisher, OutboxRelayService],
  exports: [MongoOutboxStore],
})
export class OutboxModule {}
