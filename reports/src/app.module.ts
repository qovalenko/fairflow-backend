import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { FeatureToggleModule } from './feature-toggle/feature-toggle.module';
import { AuthValidationModule } from './auth-validation/auth-validation.module';
import { MongoModule } from './mongo/mongo.module';
import { OutboxModule } from './outbox/outbox.module';
import { ReportsHealthModule } from './health/reports-health.module';
import { ReportsModule } from './reports/reports.module';
import { MetricsModule } from './metrics/metrics.module';
import { RollupModule } from './rollup/rollup.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    FeatureToggleModule,
    AuthValidationModule,
    MongoModule,
    OutboxModule,
    ReportsHealthModule,
    ReportsModule,
    MetricsModule,
    RollupModule,
  ],
})
export class AppModule {}
