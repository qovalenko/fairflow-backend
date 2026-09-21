import { HttpException, HttpStatus } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';

type WindowState = { count: number; windowStart: number };

const DEFAULT_MAX_KEYS = 50_000;

/** Per-instance fixed-window limiter for `GET /search/query` (NFR-670). */
export class SearchQueryRateLimiter {
  private readonly buckets = new Map<string, WindowState>();

  constructor(private readonly maxKeys = DEFAULT_MAX_KEYS) {}

  /** Throws 429 when the per-key budget for the current window is exhausted. */
  assertAllowed(key: string, maxRequests: number, windowMs: number): void {
    this.sweep(windowMs);
    const now = Date.now();
    let state = this.buckets.get(key);
    if (!state || now - state.windowStart >= windowMs) {
      state = { count: 0, windowStart: now };
    }
    state.count += 1;
    this.buckets.set(key, state);
    if (state.count > maxRequests) {
      throw new HttpException(
        { code: 'RESOURCE_EXHAUSTED', message: 'Слишком много запросов' },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
  }

  /** Test hook — module-level singleton must not leak state between specs. */
  reset(): void {
    this.buckets.clear();
  }

  private sweep(windowMs: number): void {
    const now = Date.now();
    for (const [key, state] of this.buckets) {
      if (now - state.windowStart >= windowMs) this.buckets.delete(key);
    }
    if (this.buckets.size <= this.maxKeys) return;
    for (const key of [...this.buckets.keys()].slice(0, this.buckets.size - this.maxKeys)) {
      this.buckets.delete(key);
    }
  }
}

export const gatewaySearchQueryRateLimiter = new SearchQueryRateLimiter();

export const SEARCH_QUERY_RATE = {
  maxRequests: parseInt(process.env.SEARCH_QUERY_RATE_MAX ?? '60', 10),
  windowMs: parseInt(process.env.SEARCH_QUERY_RATE_WINDOW_MS ?? '60000', 10),
} as const;

export function searchQueryRateLimitKeys(
  userId: string | undefined,
  ip: string,
  projectId: string,
): string[] {
  const keys: string[] = [];
  if (ip) keys.push(`search:ip:${ip}`);
  if (userId) keys.push(`search:user:${userId}:${projectId}`);
  return keys;
}

function clientIp(req: FastifyRequest): string {
  const fwd = req.headers['x-forwarded-for'];
  if (typeof fwd === 'string' && fwd.trim()) {
    return fwd.split(',')[0]?.trim().slice(0, 64) ?? '';
  }
  return (req.ip ?? '').slice(0, 64);
}

/** NFR-670: throttle regex-backed search reads before they hit Mongo. */
export function assertSearchQueryRateLimit(
  req: FastifyRequest & { user?: { userId?: string } },
  projectId: string,
): void {
  const keys = searchQueryRateLimitKeys(req.user?.userId, clientIp(req), projectId);
  for (const key of keys) {
    gatewaySearchQueryRateLimiter.assertAllowed(
      key,
      SEARCH_QUERY_RATE.maxRequests,
      SEARCH_QUERY_RATE.windowMs,
    );
  }
}

/** Test hook for gateway specs. */
export function resetSearchQueryRateLimiter(): void {
  gatewaySearchQueryRateLimiter.reset();
}
