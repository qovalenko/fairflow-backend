import { Module } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { RpcAppExceptionFilter } from '@fairflow/shared';
import { ConfigModule } from './config/config.module';
import { MongoModule } from './mongo/mongo.module';
import { AuthValidationModule } from './auth-validation/auth-validation.module';
import { HealthModule } from './health/health.module';
import { MetricsModule } from './metrics/metrics.module';
import { FeatureToggleModule } from './feature-toggle/feature-toggle.module';
import { OutboxModule } from './outbox/outbox.module';
import { CompaniesModule } from './companies/companies.module';

@Module({
  imports: [
    ConfigModule,
    MongoModule,
    // TODO-096: registers the global ModuleGuard — without it @RequireModule('companies')
    // on CompanyGrpcController is inert metadata and a project with the module switched
    // off still reaches company RPCs (product/activity wire it the same way).
    FeatureToggleModule,
    AuthValidationModule,
    HealthModule,
    MetricsModule,
    OutboxModule,
    CompaniesModule,
  ],
  providers: [
    // Maps domain AppError → proper gRPC status (K-10). Without it AppError
    // thrown from gRPC handlers surfaces as UNKNOWN 'Internal server error'.
    { provide: APP_FILTER, useClass: RpcAppExceptionFilter },
  ],
})
export class AppModule {}
