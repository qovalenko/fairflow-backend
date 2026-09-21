import { Module } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { RpcAppExceptionFilter } from '@fairflow/shared';
import { ConfigModule } from './config/config.module';
import { MongoModule } from './mongo/mongo.module';
import { HealthModule } from './health/health.module';
import { MetricsModule } from './metrics/metrics.module';
import { FeatureToggleModule } from './feature-toggle/feature-toggle.module';
import { AuthValidationModule } from './auth-validation/auth-validation.module';
import { OutboxModule } from './outbox/outbox.module';
import { ProductModule } from './product/product.module';
import { UsageModule } from './usage/usage.module';

@Module({
  imports: [
    ConfigModule,
    FeatureToggleModule,
    AuthValidationModule,
    MongoModule,
    OutboxModule,
    HealthModule,
    MetricsModule,
    ProductModule,
    UsageModule,
  ],
  providers: [{ provide: APP_FILTER, useClass: RpcAppExceptionFilter }],
})
export class AppModule {}
