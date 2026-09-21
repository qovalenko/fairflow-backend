import { Injectable } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { Strategy } from 'passport-jwt';
import { ConfigService } from '@nestjs/config';
import type { FastifyRequest } from 'fastify';
import type { JwtPayload } from '../auth.service';
import { ACCESS_TOKEN_COOKIE } from '../constants';

export interface JwtValidatePayload {
  userId: string;
  login: string;
  email: string;
}

function fromCookieOrBearer(
  req: FastifyRequest & { cookies?: { [key: string]: string } },
): string | null {
  const token = req.cookies?.[ACCESS_TOKEN_COOKIE];
  if (token) return token;
  const auth = (req as { headers?: { authorization?: string } }).headers?.authorization;
  if (auth?.startsWith('Bearer ')) return auth.slice(7);
  return null;
}

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy, 'jwt') {
  constructor(configService: ConfigService) {
    super({
      jwtFromRequest: fromCookieOrBearer,
      ignoreExpiration: false,
      secretOrKey: configService.get<string>('app.jwt.secret', 'change-me'),
    });
  }

  validate(payload: JwtPayload & { email?: string }): JwtValidatePayload {
    return {
      userId: payload.sub,
      login: payload.login,
      email: typeof payload.email === 'string' ? payload.email : '',
    };
  }
}
