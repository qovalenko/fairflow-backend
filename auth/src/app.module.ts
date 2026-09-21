import { Module } from '@nestjs/common';
import { ConfigModule } from './config/config.module';
import { PrismaModule } from './prisma/prisma.module';
import { HealthModule } from './health/health.module';
import { MetricsModule } from './metrics/metrics.module';
import { AuthModule } from './auth/auth.module';
import { OidcModule } from './oidc/oidc.module';

@Module({
  imports: [ConfigModule, PrismaModule, HealthModule, MetricsModule, AuthModule, OidcModule],
})
export class AppModule {}
