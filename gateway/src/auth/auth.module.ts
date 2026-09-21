import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';

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
import { PassportModule } from '@nestjs/passport';
import { ConfigService } from '@nestjs/config';
import { AuthService } from './auth.service';
import { AuthController } from './auth.controller';
import { ProfileController } from './profile.controller';
import { ProfilePublicController } from './profile-public.controller';
import { OauthYandexController } from './oauth-yandex.controller';
import { OidcBffController } from './oidc.controller';
import { OidcClientService } from './oidc-client.service';
import { AuthEmployeeGateService } from './auth-employee-gate.service';
import { JwtStrategy } from './strategies/jwt.strategy';
import { AvatarStorageService } from './avatar-storage.service';
import { GatewayEventsService } from '../events/gateway-events.service';
import { ProjectAccessGuard } from '../guards/project-access.guard';
import { AuthPublicThrottleGuard } from './auth-public-throttle.guard';
import { RedisPubSubService } from '../bff/redis-pubsub.service';
import { ConfigModule } from '../config/config.module';

@Module({
  imports: [
    ConfigModule,
    PassportModule.register({ defaultStrategy: 'jwt' }),
    JwtModule.registerAsync({
      useFactory: (config: ConfigService) => {
        const expiresInStr = config.get<string>('app.jwt.expiresIn', '24h');
        const expiresInSeconds = parseExpiresIn(expiresInStr);
        return {
          secret: config.get<string>('app.jwt.secret', 'change-me'),
          signOptions: { expiresIn: expiresInSeconds },
        };
      },
      inject: [ConfigService],
    }),
  ],
  controllers: [
    AuthController,
    ProfileController,
    ProfilePublicController,
    OauthYandexController,
    OidcBffController,
  ],
  providers: [
    AuthService,
    JwtStrategy,
    AvatarStorageService,
    OidcClientService,
    AuthEmployeeGateService,
    GatewayEventsService,
    ProjectAccessGuard,
    RedisPubSubService,
    AuthPublicThrottleGuard,
  ],
  exports: [AuthService, GatewayEventsService],
})
export class AuthModule {}
