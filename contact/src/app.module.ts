import { Module } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { RpcAppExceptionFilter } from '@fairflow/shared';
import { ConfigModule } from './config/config.module';
import { MongoModule } from './mongo/mongo.module';
import { AuthValidationModule } from './auth-validation/auth-validation.module';
import { HealthModule } from './health/health.module';
import { MetricsModule } from './metrics/metrics.module';
import { ContactsModule } from './contacts/contacts.module';
import { FeatureToggleModule } from './feature-toggle/feature-toggle.module';
import { OutboxModule } from './outbox/outbox.module';

@Module({
  imports: [
    ConfigModule,
    MongoModule,
    OutboxModule,
    AuthValidationModule,
    // TODO-072: без этого импорта APP_GUARD ModuleGuard не регистрируется и
    // @RequireModule('contacts') на gRPC-контроллере остаётся декларацией —
    // выключенный в проекте модуль всё равно отвечал бы данными. Идёт ПОСЛЕ
    // AuthValidationModule, чтобы порядок глобальных гвардов оставался
    // api-key → visibility-hydration → roles → module.
    FeatureToggleModule,
    HealthModule,
    MetricsModule,
    ContactsModule,
  ],
  providers: [
    // Maps domain AppError → proper gRPC status (K-10). Without it AppError
    // thrown from gRPC handlers surfaces as UNKNOWN 'Internal server error'.
    { provide: APP_FILTER, useClass: RpcAppExceptionFilter },
  ],
})
export class AppModule {}
