import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { FeatureToggleModule } from './feature-toggle/feature-toggle.module';
import { AuthValidationModule } from './auth-validation/auth-validation.module';
import { MongoModule } from './mongo/mongo.module';
import { PlatformHealthModule } from './health/platform-health.module';
import { PlatformModule } from './platform/platform.module';
import { MetricsModule } from './metrics/metrics.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    FeatureToggleModule,
    AuthValidationModule,
    MongoModule,
    PlatformHealthModule,
    PlatformModule,
    MetricsModule,
  ],
})
export class AppModule {}
