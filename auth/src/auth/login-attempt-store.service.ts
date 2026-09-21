import { Injectable, Logger } from '@nestjs/common';

export interface LoginAttemptState {
  fails: number;
  firstFailAt: number;
  lockedUntil: number;
}

type RedisLike = {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ex: 'EX', ttlSeconds: number): Promise<unknown>;
  del(key: string): Promise<number>;
  on(event: string, cb: () => void): void;
};

const REDIS_PREFIX = 'auth:login-attempt:';
const LOGIN_MAX_ATTEMPTS = 5;
const LOGIN_IP_MAX_ATTEMPTS = 30;
const LOGIN_LOCK_MS = 15 * 60_000;
const LOGIN_WINDOW_MS = 15 * 60_000;
const LOGIN_TRACKER_MAX = 50_000;

/** Fail-fast outside dev/test when REDIS_URL is missing (NFR-AUTH-040 / FR-AUTH-060). */
export function assertRedisConfiguredForProduction(): void {
  const env = process.env.NODE_ENV?.trim().toLowerCase();
  if (env === 'development' || env === 'test') return;
  if (!process.env.REDIS_URL?.trim()) {
    throw new Error(
      'REDIS_URL is required outside development for distributed login-attempt tracking (NFR-AUTH-040)',
    );
  }
}

/**
 * NFR-AUTH-040: distributed login brute-force tracker.
 * Uses Redis when `REDIS_URL` is set (multi-replica correct); falls back to
 * per-process memory when Redis is unavailable (dev / single replica).
 */
@Injectable()
export class LoginAttemptStore {
  private readonly logger = new Logger(LoginAttemptStore.name);
  private readonly memory = new Map<string, LoginAttemptState>();
  private client: RedisLike | null = null;
  private connecting: Promise<RedisLike | null> | null = null;

  private async redis(): Promise<RedisLike | null> {
    const url = process.env.REDIS_URL?.trim();
    if (!url) return null;
    if (this.client) return this.client;
    if (!this.connecting) this.connecting = this.connect(url);
    return this.connecting;
  }

  private async connect(url: string): Promise<RedisLike | null> {
    try {
      const mod = await import('ioredis').catch(() => null);
      if (!mod) {
        this.logger.warn('ioredis is not installed — login attempt store uses in-memory fallback.');
        return null;
      }
      const Redis = (typeof mod === 'function' ? mod : mod.default) as new (
        url: string,
      ) => RedisLike;
      const client = new Redis(url);
      client.on('error', () => {
        this.client = null;
        this.connecting = null;
      });
      this.client = client;
      return client;
    } catch (e) {
      this.logger.warn(`Redis connect failed for login attempts: ${(e as Error).message}`);
      return null;
    }
  }

  private redisKey(key: string): string {
    return `${REDIS_PREFIX}${key}`;
  }

  private maxAttemptsForKey(key: string): number {
    return key.startsWith('ip:') ? LOGIN_IP_MAX_ATTEMPTS : LOGIN_MAX_ATTEMPTS;
  }

  private sweepMemory(): void {
    const now = Date.now();
    for (const [key, s] of this.memory) {
      if (s.lockedUntil <= now && now - s.firstFailAt > LOGIN_WINDOW_MS) {
        this.memory.delete(key);
      }
    }
  }

  private evictMemoryOverflow(): void {
    if (this.memory.size <= LOGIN_TRACKER_MAX) return;
    this.sweepMemory();
    while (this.memory.size > LOGIN_TRACKER_MAX) {
      const oldest = this.memory.keys().next().value;
      if (oldest === undefined) break;
      this.memory.delete(oldest);
    }
  }

  private async readState(key: string): Promise<LoginAttemptState | null> {
    const r = await this.redis();
    if (r) {
      const raw = await r.get(this.redisKey(key));
      if (!raw) return null;
      try {
        return JSON.parse(raw) as LoginAttemptState;
      } catch {
        return null;
      }
    }
    this.sweepMemory();
    return this.memory.get(key) ?? null;
  }

  private async writeState(key: string, state: LoginAttemptState): Promise<void> {
    const r = await this.redis();
    if (r) {
      const ttlSec = Math.ceil(
        Math.max(LOGIN_LOCK_MS, LOGIN_WINDOW_MS, state.lockedUntil - Date.now()) / 1000,
      );
      await r.set(this.redisKey(key), JSON.stringify(state), 'EX', Math.max(ttlSec, 60));
      return;
    }
    this.memory.set(key, state);
    this.evictMemoryOverflow();
  }

  private async deleteState(key: string): Promise<void> {
    const r = await this.redis();
    if (r) {
      await r.del(this.redisKey(key));
      return;
    }
    this.memory.delete(key);
  }

  async assertNotLocked(keys: string[]): Promise<void> {
    const now = Date.now();
    for (const key of keys) {
      const s = await this.readState(key);
      if (s && s.lockedUntil > now) {
        const err = new Error('Too many failed login attempts, try again later');
        (err as Error & { errorCode?: string }).errorCode = 'rateLimit';
        throw err;
      }
    }
  }

  async registerFailure(key: string): Promise<void> {
    const maxAttempts = this.maxAttemptsForKey(key);
    const now = Date.now();
    let s = await this.readState(key);
    if (!s || now - s.firstFailAt > LOGIN_WINDOW_MS) {
      s = { fails: 0, firstFailAt: now, lockedUntil: 0 };
    }
    s.fails += 1;
    if (s.fails >= maxAttempts) {
      s.lockedUntil = now + LOGIN_LOCK_MS;
    }
    await this.writeState(key, s);
  }

  async reset(keys: string[]): Promise<void> {
    for (const key of keys) {
      await this.deleteState(key);
    }
  }

  /** Test-only: clear in-memory fallback state. */
  resetMemoryForTests(): void {
    this.memory.clear();
  }
}
