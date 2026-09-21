import { Injectable } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { Strategy } from 'passport-local';
import { AuthService } from '../auth.service';

@Injectable()
export class LocalStrategy extends PassportStrategy(Strategy, 'local') {
  constructor(private readonly authService: AuthService) {
    super({
      usernameField: 'email',
      passwordField: 'password',
      passReqToCallback: true,
    });
  }

  async validate(
    req: { body?: { email?: string; login?: string } },
    emailOrLogin: string,
    password: string,
  ) {
    const identifier = req.body?.email ?? req.body?.login ?? emailOrLogin;
    if (!identifier?.trim()) return null;
    const user = await this.authService.validateUser(identifier.trim(), password);
    if (!user) return null;
    return user;
  }
}
