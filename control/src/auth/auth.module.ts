import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { AppConfigService } from '../config/app-config.service';
import { JwtStrategy } from './strategies/jwt.strategy';

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
    PassportModule.register({ defaultStrategy: 'jwt' }),
    JwtModule.registerAsync({
      useFactory: (config: AppConfigService) => ({
        secret: config.jwtSecret,
        signOptions: { expiresIn: parseExpiresIn(config.jwtExpiresIn ?? '15m') },
      }),
      inject: [AppConfigService],
    }),
  ],
  providers: [JwtStrategy],
  exports: [JwtModule],
})
export class AuthModule {}
