import { Module } from '@nestjs/common';
import { ConfigModule } from './config/config.module';
import { PrismaModule } from './prisma/prisma.module';
import { AuthModule } from './auth/auth.module';
import { HealthModule } from './health/health.module';
import { MetricsModule } from './metrics/metrics.module';
import { UsersModule } from './users/users.module';
import { GrpcBffModule } from './bff/grpc-bff.module';
import { BffApiModule } from './bff/bff-api.module';
import { BoxedModule } from './boxed/boxed.module';

// box (on-prem, §5.1): the boxed public-config + onboarding endpoints
// (`/api/public-config`, `/api/bootstrap`) are part of the on-prem build.
@Module({
  imports: [
    GrpcBffModule,
    BffApiModule,
    ConfigModule,
    PrismaModule,
    AuthModule,
    HealthModule,
    MetricsModule,
    UsersModule,
    BoxedModule,
  ],
})
export class AppModule {}
