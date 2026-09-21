import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { FeatureToggleModule } from './feature-toggle/feature-toggle.module';
import { AuthValidationModule } from './auth-validation/auth-validation.module';
import { MongoModule } from './mongo/mongo.module';
import { OutboxModule } from './outbox/outbox.module';
import { S3Module } from './s3/s3.module';
import { DocumentsModule } from './documents/documents.module';
import { MetricsModule } from './metrics/metrics.module';
import { HealthModule } from './health/health.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    FeatureToggleModule,
    AuthValidationModule,
    MongoModule,
    OutboxModule,
    S3Module,
    DocumentsModule,
    MetricsModule,
    HealthModule,
  ],
})
export class AppModule {}
