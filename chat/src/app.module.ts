import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { FeatureToggleModule } from './feature-toggle/feature-toggle.module';
import { AuthValidationModule } from './auth-validation/auth-validation.module';
import { MongoModule } from './mongo/mongo.module';
import { OutboxModule } from './outbox/outbox.module';
import { HealthModule } from './health/health.module';
import { ChatModule } from './chat/chat.module';
import { MetricsModule } from './metrics/metrics.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    FeatureToggleModule,
    AuthValidationModule,
    MongoModule,
    OutboxModule,
    HealthModule,
    ChatModule,
    MetricsModule,
  ],
})
export class AppModule {}
