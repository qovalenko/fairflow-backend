import { Module } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { RpcAppExceptionFilter } from '@fairflow/shared';
import { ConfigModule } from './config/config.module';
import { MongoModule } from './mongo/mongo.module';
import { HealthModule } from './health/health.module';
import { MetricsModule } from './metrics/metrics.module';
import { AuthValidationModule } from './auth-validation/auth-validation.module';
import { OutboxModule } from './outbox/outbox.module';
import { OrdersModule } from './orders/orders.module';
import { FeatureToggleModule } from './feature-toggle/feature-toggle.module';

@Module({
  imports: [
    ConfigModule,
    // Registers the global ModuleGuard so @RequireModule('orders') is enforced
    // against the gateway-resolved x-enabled-modules set (TODO-080).
    FeatureToggleModule,
    AuthValidationModule,
    MongoModule,
    OutboxModule,
    HealthModule,
    MetricsModule,
    OrdersModule,
  ],
  providers: [
    // Maps domain AppError → proper gRPC status (K-10). Without it AppError
    // thrown from gRPC handlers surfaces as UNKNOWN 'Internal server error'.
    { provide: APP_FILTER, useClass: RpcAppExceptionFilter },
  ],
})
export class AppModule {}
