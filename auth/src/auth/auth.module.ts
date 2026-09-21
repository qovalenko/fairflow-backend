import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { JwtModule } from '@nestjs/jwt';
import { ConfigModule } from '../config/config.module';
import { AppConfigService } from '../config/app-config.service';
import { AuthService } from './auth.service';
import { ProfileService } from './profile.service';
import { ProfileEventsService } from './profile-events.service';
import { AuthBusPublisherService } from './auth-bus-publisher.service';
import { SessionDenyPushService } from './session-deny-push.service';
import { Require2faPolicyService } from './require2fa-policy.service';
import { LoginAttemptStore } from './login-attempt-store.service';
import { AuthGrpcController } from './auth.grpc.controller';
import { GrpcGatewayKeyGuard } from './grpc-gateway-key.guard';
import { ApiKeysModule } from '../api-keys/api-keys.module';
import { ApiKeyGrpcController } from '../api-keys/api-key.grpc.controller';

function parseExpiresIn(s: string): number {
  const match = s.match(/^(\d+)(d|h|m|s)?$/);
  if (!match) return 604800;
  const n = parseInt(match[1], 10);
  const unit = match[2] ?? 's';
  if (unit === 'd') return n * 86400;
  if (unit === 'h') return n * 3600;
  if (unit === 'm') return n * 60;
  return n;
}

@Module({
  imports: [
    ConfigModule,
    ApiKeysModule,
    JwtModule.registerAsync({
      useFactory: (config: AppConfigService) => ({
        secret: config.jwtSecret,
        signOptions: { expiresIn: parseExpiresIn(process.env.JWT_EXPIRE ?? '24h') },
      }),
      inject: [AppConfigService],
    }),
  ],
  controllers: [AuthGrpcController, ApiKeyGrpcController],
  providers: [
    AuthService,
    ProfileService,
    ProfileEventsService,
    Require2faPolicyService,
    AuthBusPublisherService,
    SessionDenyPushService,
    LoginAttemptStore,
    { provide: APP_GUARD, useClass: GrpcGatewayKeyGuard },
  ],
  exports: [AuthService],
})
export class AuthModule {}
