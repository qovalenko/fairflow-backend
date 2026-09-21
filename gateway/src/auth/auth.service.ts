import { Injectable } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcryptjs';
import { PrismaService } from '../prisma/prisma.service';
import { AppError } from '@fairflow/shared';

export interface JwtPayload {
  sub: string;
  login: string;
  email?: string;
}

export interface AuthResult {
  accessToken: string;
  expiresIn: string;
  user: { id: string; login: string; email: string; name: string | null };
}

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jwtService: JwtService,
  ) {}

  async validateUser(
    login: string,
    password: string,
  ): Promise<{ id: string; login: string; email: string; name: string | null } | null> {
    const user = await this.prisma.user.findUnique({
      where: { login, isActive: true },
      select: { id: true, login: true, email: true, name: true, password: true },
    });
    if (!user || !(await bcrypt.compare(password, user.password))) return null;
    const { password: _p, ...rest } = user;
    return rest;
  }

  async validateAndLogin(login: string, password: string): Promise<AuthResult> {
    const user = await this.validateUser(login, password);
    if (!user) throw new AppError('auth', 'Invalid login or password');
    return this.issueToken(user);
  }

  issueToken(user: { id: string; login: string; email: string; name: string | null }): AuthResult {
    const payload: JwtPayload = {
      sub: user.id,
      login: user.login,
      email: user.email.trim().toLowerCase(),
    };
    const expiresInStr = process.env.JWT_EXPIRE ?? '24h';
    const expiresInSeconds = this.parseExpiresIn(expiresInStr);
    const accessToken = this.jwtService.sign(payload as object, { expiresIn: expiresInSeconds });
    return {
      accessToken,
      expiresIn: expiresInStr,
      user,
    };
  }

  private parseExpiresIn(s: string): number {
    const match = s.match(/^(\d+)(d|h|m|s)?$/);
    if (!match) return 604800;
    const n = parseInt(match[1], 10);
    const unit = match[2] ?? 's';
    if (unit === 'd') return n * 86400;
    if (unit === 'h') return n * 3600;
    if (unit === 'm') return n * 60;
    return n;
  }

  async me(
    userId: string,
  ): Promise<{ id: string; login: string; email: string; name: string | null } | null> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId, isActive: true },
      select: { id: true, login: true, email: true, name: true },
    });
    return user;
  }
}
