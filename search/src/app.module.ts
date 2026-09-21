import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { FeatureToggleModule } from './feature-toggle/feature-toggle.module';
import { AuthValidationModule } from './auth-validation/auth-validation.module';
import { MongoModule } from './mongo/mongo.module';
import { SearchHealthModule } from './health/search-health.module';
import { SearchModule } from './search/search.module';
import { MetricsModule } from './metrics/metrics.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    FeatureToggleModule,
    AuthValidationModule,
    MongoModule,
    SearchHealthModule,
    SearchModule,
    MetricsModule,
  ],
})
export class AppModule {}
