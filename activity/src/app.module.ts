import { Module } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { RpcAppExceptionFilter } from '@fairflow/shared';
import { ConfigModule } from './config/config.module';
import { MongoModule } from './mongo/mongo.module';
import { OutboxModule } from './outbox/outbox.module';
import { AuthValidationModule } from './auth-validation/auth-validation.module';
import { ActivityModule } from './activity/activity.module';
import { FeatureToggleModule } from './feature-toggle/feature-toggle.module';
import { HealthModule } from './health/health.module';
import { MetricsModule } from './metrics/metrics.module';

@Module({
  imports: [
    ConfigModule,
    FeatureToggleModule,
    AuthValidationModule,
    MongoModule,
    OutboxModule,
    ActivityModule,
    HealthModule,
    MetricsModule,
  ],
  providers: [{ provide: APP_FILTER, useClass: RpcAppExceptionFilter }],
})
export class AppModule {}
