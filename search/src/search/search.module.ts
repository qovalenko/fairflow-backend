import { Module } from '@nestjs/common';
import { SearchService } from './search.service';
import { SearchGrpcController } from './search.grpc.controller';
import { MongoModule } from '../mongo/mongo.module';
import { RabbitMqService } from '../messaging/rabbitmq.service';
import { DeadLetterCounter } from '../messaging/dead-letter.counter';
import { SearchProjectionService } from './search-projection.service';
import { ProjectPurgeConsumer } from './project-purge.consumer';
import { ProjectionApply, SEARCH_DELTA_WRITER } from './search-projection.apply';
import { SearchDeltaWriterImpl } from './search-delta.writer';

@Module({
  imports: [MongoModule],
  controllers: [SearchGrpcController],
  providers: [
    SearchService,
    RabbitMqService,
    // Dead-letter accounting behind Status.dead_letter_count (TODO-484).
    DeadLetterCounter,
    // Event delta projection (E4-19): consumer → upsert/tombstone into search_index.
    { provide: SEARCH_DELTA_WRITER, useClass: SearchDeltaWriterImpl },
    ProjectionApply,
    SearchProjectionService,
    ProjectPurgeConsumer,
  ],
})
export class SearchModule {}
