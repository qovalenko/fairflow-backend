import { HttpException, HttpStatus } from '@nestjs/common';

type WindowState = { count: number; windowStart: number };

const DEFAULT_MAX_KEYS = 50_000;

/** Fixed-window limiter (same pattern as search-rate-limit.ts). */
export class ChatFixedWindowRateLimiter {
  private readonly buckets = new Map<string, WindowState>();

  constructor(private readonly maxKeys = DEFAULT_MAX_KEYS) {}

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
        { code: 'CHAT_RATE_LIMITED', message: 'Слишком часто, повторите позже' },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
  }

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

/** Per-user WS connection cap (NFR-CHAT-090). */
export class ChatWsConnectionRegistry {
  private readonly perUser = new Map<string, number>();
  private total = 0;
  private onTotalChange?: (total: number) => void;

  constructor(
    private readonly maxPerUser = parseInt(process.env.CHAT_WS_MAX_CONN_PER_USER ?? '5', 10),
  ) {}

  bindGauge(onTotalChange: (total: number) => void): void {
    this.onTotalChange = onTotalChange;
    onTotalChange(this.total);
  }

  tryAcquire(userId: string): boolean {
    if (!userId) return false;
    const cur = this.perUser.get(userId) ?? 0;
    if (cur >= this.maxPerUser) return false;
    this.perUser.set(userId, cur + 1);
    this.total += 1;
    this.onTotalChange?.(this.total);
    return true;
  }

  release(userId: string): void {
    if (!userId) return;
    const cur = this.perUser.get(userId) ?? 0;
    if (cur <= 1) this.perUser.delete(userId);
    else this.perUser.set(userId, cur - 1);
    if (this.total > 0) {
      this.total -= 1;
      this.onTotalChange?.(this.total);
    }
  }

  reset(): void {
    this.perUser.clear();
    this.total = 0;
    this.onTotalChange?.(0);
  }
}

export const chatTypingRateLimiter = new ChatFixedWindowRateLimiter();
export const chatIntegrationRateLimiter = new ChatFixedWindowRateLimiter();
export const chatWsConnectionRegistry = new ChatWsConnectionRegistry();

export const CHAT_TYPING_RATE = {
  maxRequests: parseInt(process.env.CHAT_TYPING_RATE_MAX ?? '1', 10),
  windowMs: parseInt(process.env.CHAT_TYPING_RATE_WINDOW_MS ?? '1000', 10),
} as const;

export const CHAT_INTEGRATION_RATE = {
  maxRequests: parseInt(process.env.CHAT_INTEGRATION_RATE_MAX ?? '30', 10),
  windowMs: parseInt(process.env.CHAT_INTEGRATION_RATE_WINDOW_MS ?? '60000', 10),
} as const;

export function assertChatTypingAllowed(userId: string, conversationId: string): void {
  if (!userId || !conversationId) return;
  chatTypingRateLimiter.assertAllowed(
    `typing:${userId}:${conversationId}`,
    CHAT_TYPING_RATE.maxRequests,
    CHAT_TYPING_RATE.windowMs,
  );
}

export function assertChatIntegrationRateLimit(userId: string, projectId: string): void {
  const keys = [`integration:user:${userId}`, `integration:project:${projectId}`].filter(Boolean);
  for (const key of keys) {
    chatIntegrationRateLimiter.assertAllowed(
      key,
      CHAT_INTEGRATION_RATE.maxRequests,
      CHAT_INTEGRATION_RATE.windowMs,
    );
  }
}
