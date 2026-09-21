import {
  CanActivate,
  ExecutionContext,
  HttpException,
  HttpStatus,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { FastifyRequest } from 'fastify';
import { RedisPubSubService } from '../bff/redis-pubsub.service';
import {
  AUTH_PUBLIC_THROTTLE_KEY,
  type AuthPublicThrottleOptions,
} from './auth-public-throttle.decorator';

/**
 * FR-AUTH-205 / @nestjs/throttler-equivalent guard for public auth routes.
 * Redis-backed when available (multi-replica); in-process fallback otherwise.
 */
@Injectable()
export class AuthPublicThrottleGuard implements CanActivate {
  private readonly memory = new Map<string, { count: number; resetAt: number }>();

  constructor(
    private readonly reflector: Reflector,
    private readonly redis: RedisPubSubService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const opts = this.reflector.getAllAndOverride<AuthPublicThrottleOptions | undefined>(
      AUTH_PUBLIC_THROTTLE_KEY,
      [context.getHandler(), context.getClass()],
    );
    if (!opts) return true;

    const req = context
      .switchToHttp()
      .getRequest<FastifyRequest & { body?: Record<string, unknown> }>();
    const keys = this.trackerKeys(req, opts);
    for (const key of keys) {
      const allowed = await this.consume(key, opts.limit, opts.ttlMs);
      if (!allowed) {
        throw new HttpException(
          'Too many requests — try again later',
          HttpStatus.TOO_MANY_REQUESTS,
        );
      }
    }
    return true;
  }

  private trackerKeys(
    req: FastifyRequest & { body?: Record<string, unknown> },
    opts: AuthPublicThrottleOptions,
  ): string[] {
    const ip = this.clientIp(req);
    const keys = [`auth-public:ip:${ip}`];
    for (const extra of opts.extraKeys?.(req) ?? []) {
      const t = extra.trim();
      if (t) keys.push(`auth-public:${t}`);
    }
    return keys;
  }

  /** Same TRUST_PROXY / X-Forwarded-For rule as AuthController.clientIp (NFR-AUTH-045). */
  private clientIp(req: FastifyRequest): string {
    const trustProxy = ['true', '1', 'on'].includes(
      String(process.env.TRUST_PROXY ?? '')
        .trim()
        .toLowerCase(),
    );
    if (trustProxy) {
      const fwd = req.headers?.['x-forwarded-for'];
      const fromFwd = (
        Array.isArray(fwd) ? fwd[0] : typeof fwd === 'string' ? fwd.split(',')[0] : ''
      )?.trim();
      if (fromFwd) return fromFwd.slice(0, 64);
    }
    return (req.ip ?? 'unknown').slice(0, 64);
  }

  private async consume(key: string, limit: number, ttlMs: number): Promise<boolean> {
    if (this.redis.redisEnabled) {
      const raw = await this.redis.get(key);
      const now = Date.now();
      let count = 0;
      let resetAt = now + ttlMs;
      if (raw) {
        try {
          const parsed = JSON.parse(raw) as { count?: number; resetAt?: number };
          count = parsed.count ?? 0;
          resetAt = parsed.resetAt ?? resetAt;
        } catch {
          count = 0;
        }
      }
      if (resetAt <= now) {
        count = 0;
        resetAt = now + ttlMs;
      }
      count += 1;
      const ttlSec = Math.max(1, Math.ceil((resetAt - now) / 1000));
      await this.redis.setEx(key, JSON.stringify({ count, resetAt }), ttlSec);
      return count <= limit;
    }

    const now = Date.now();
    let row = this.memory.get(key);
    if (!row || row.resetAt <= now) {
      row = { count: 0, resetAt: now + ttlMs };
    }
    row.count += 1;
    this.memory.set(key, row);
    return row.count <= limit;
  }

  resetForTests(): void {
    this.memory.clear();
  }
}
