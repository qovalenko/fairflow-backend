import { Injectable } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { ConfigService } from '@nestjs/config';

export interface JwtValidatePayload {
  userId: string;
  login?: string;
}

interface JwtPayload {
  sub: string;
  login?: string;
}

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy, 'jwt') {
  constructor(configService: ConfigService) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: configService.get<string>('app.jwt.secret', 'change-me'),
    });
  }

  validate(payload: JwtPayload): JwtValidatePayload {
    return { userId: payload.sub, login: payload.login };
  }
}
