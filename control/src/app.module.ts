import { Module } from '@nestjs/common';
import { ConfigModule } from './config/config.module';
import { PrismaModule } from './prisma/prisma.module';
import { AuthValidationModule } from './auth-validation/auth-validation.module';
import { HealthModule } from './health/health.module';
import { MetricsModule } from './metrics/metrics.module';
import { ProjectsModule } from './projects/projects.module';
import { OrganizationsModule } from './organizations/organizations.module';
import { GrpcControlModule } from './grpc/grpc-control.module';
import { WebhooksModule } from './webhooks/webhooks.module';

@Module({
  imports: [
    ConfigModule,
    PrismaModule,
    AuthValidationModule,
    HealthModule,
    MetricsModule,
    ProjectsModule,
    OrganizationsModule,
    GrpcControlModule,
    WebhooksModule,
  ],
})
export class AppModule {}
