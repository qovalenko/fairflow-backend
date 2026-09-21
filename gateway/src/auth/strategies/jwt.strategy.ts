import { Injectable, UnauthorizedException } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { ConfigService } from '@nestjs/config';
import type { JwtPayload } from '../auth.service';

export interface JwtValidatePayload {
  userId: string;
  login: string;
  email: string;
  sessionId: string;
}

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy, 'jwt') {
  constructor(configService: ConfigService) {
    const fromCookie = (req: { headers?: { cookie?: string } }): string | null => {
      const raw = req?.headers?.cookie;
      if (!raw) return null;
      const pairs = raw.split(';').map((x) => x.trim());
      for (const p of pairs) {
        if (p.startsWith('ff_access_token=')) {
          const v = p.slice('ff_access_token='.length);
          return v ? decodeURIComponent(v) : null;
        }
      }
      for (const p of pairs) {
        if (p.startsWith('token=')) {
          const v = p.slice('token='.length);
          return v ? decodeURIComponent(v) : null;
        }
      }
      return null;
    };
    super({
      jwtFromRequest: ExtractJwt.fromExtractors([
        ExtractJwt.fromAuthHeaderAsBearerToken(),
        fromCookie,
      ]),
      ignoreExpiration: false,
      secretOrKey: configService.get<string>('app.jwt.secret', 'change-me'),
    });
  }

  validate(payload: Partial<JwtPayload> & { jti?: unknown; kind?: unknown }): JwtValidatePayload {
    // Fail-closed (TODO-006): only real access tokens may authenticate. Purpose
    // tokens (mfa_challenge / pwd_reset / email_verify) carry a `kind` claim, and
    // every issued access token carries a string jti — reject everything else so a
    // leaked preauth challenge can never be used as a Bearer token, and so the
    // session deny-list always has a jti to check.
    if (
      payload.kind !== undefined ||
      typeof payload.jti !== 'string' ||
      !payload.jti ||
      typeof payload.sub !== 'string' ||
      !payload.sub
    ) {
      throw new UnauthorizedException('invalid access token');
    }
    return {
      userId: payload.sub,
      login: typeof payload.login === 'string' ? payload.login : '',
      email: typeof payload.email === 'string' ? payload.email : '',
      sessionId: payload.jti,
    };
  }
}
