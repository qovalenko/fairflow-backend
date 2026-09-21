import { Module } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { RpcAppExceptionFilter } from '@fairflow/shared';
import { ConfigModule } from './config/config.module';
import { MongoModule } from './mongo/mongo.module';
import { PipeModule } from './pipe/pipe.module';
import { MetricsModule } from './metrics/metrics.module';
import { OutboxModule } from './outbox/outbox.module';
import { AuthValidationModule } from './auth-validation/auth-validation.module';

@Module({
  imports: [
    ConfigModule,
    AuthValidationModule,
    MongoModule,
    OutboxModule,
    PipeModule,
    MetricsModule,
  ],
  providers: [
    // K-10: map domain AppError → gRPC status for the whole app (gateway can
    // then translate to a meaningful HTTP status). Inherited by the gRPC
    // microservice via `inheritAppConfig` in main.ts.
    { provide: APP_FILTER, useClass: RpcAppExceptionFilter },
  ],
})
export class AppModule {}
