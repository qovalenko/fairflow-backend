import { Module } from '@nestjs/common';
import { MongoModule } from '../mongo/mongo.module';
import { ReportsRabbitMqConsumer } from '../messaging/rabbitmq-consumer.service';
import { StatisticsRollupStore } from './statistics-rollup.store';
import { StatisticsRollupConsumer } from './statistics-rollup.consumer';
import { StatisticsRollupCoverageStore } from './statistics-rollup-coverage';
import { StageTransitionsStore } from '../stage-transitions/stage-transitions.store';
import { StageTransitionsConsumer } from '../stage-transitions/stage-transitions.consumer';

/**
 * Statistics-rollup materialization (P2.f) + stage-transitions projection
 * (FR-REPORTS-250). Disabled with env flags (tests / read-only replicas).
 */
@Module({
  imports: [MongoModule],
  providers: [
    ReportsRabbitMqConsumer,
    StatisticsRollupStore,
    StatisticsRollupConsumer,
    StatisticsRollupCoverageStore,
    StageTransitionsStore,
    StageTransitionsConsumer,
  ],
  exports: [StatisticsRollupStore, StatisticsRollupCoverageStore, StageTransitionsStore],
})
export class RollupModule {}
