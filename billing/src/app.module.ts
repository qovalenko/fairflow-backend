import { Module } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { ConfigModule } from '@nestjs/config';
import { RpcAppExceptionFilter } from '@fairflow/shared';
import configuration from './config/configuration';
import { AppConfigModule } from './config/config.module';
import { AuthValidationModule } from './auth-validation/auth-validation.module';
import { FeatureToggleModule } from './feature-toggle/feature-toggle.module';
import { PrismaModule } from './prisma/prisma.module';
import { HealthModule } from './health/health.module';
import { BillingModule } from './billing/billing.module';
import { MetricsModule } from './metrics/metrics.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, load: [configuration] }),
    AppConfigModule,
    FeatureToggleModule,
    AuthValidationModule,
    PrismaModule,
    HealthModule,
    BillingModule,
    MetricsModule,
  ],
  providers: [{ provide: APP_FILTER, useClass: RpcAppExceptionFilter }],
})
export class AppModule {}
