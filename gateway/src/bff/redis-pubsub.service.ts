import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { EventEmitter } from 'node:events';
import { AppConfigService } from '../config/app-config.service';

/**
 * Cross-replica Pub/Sub + ephemeral KV seam for gateway realtime (M-CHAT-6).
 *
 * This is the REAL Redis backing that the notification SSE seam
 * (`notification-stream.service.ts`, `// REDIS SEAM`) only documented. It is
 * deliberately generic so BOTH chat (`chat:conv:{id}`, `chat:badge:{userId}`,
 * presence/open-state TTL keys) and notifications (`notif:user:{userId}`) fan
 * out through one connection pair (contracts/chat.md §5.3/§7, NFR-CHAT-6).
 *
 * Transport resolution:
 *  - When `REDIS_URL` is set AND `ioredis` is installed, a publisher + a
 *    subscriber connection are opened. A frame published on replica A reaches
 *    every subscriber on replica B (multi-replica fanout without sticky
 *    sessions, OQ-CHAT-16). Locally-published frames are ALSO emitted in-process
 *    immediately, so the publishing replica never waits on the round-trip.
 *  - When Redis is not configured/installed/reachable, it degrades to a pure
 *    in-process `EventEmitter` — single-replica correct, build/bootstrap stay
 *    green with no hard dependency on the native client (same philosophy as the
 *    prior documented seam). `ioredis` is imported lazily so a missing module
 *    never breaks `nest build`.
 */

type RedisLike = {
  publish(channel: string, message: string): Promise<number>;
  subscribe(...channels: string[]): Promise<number>;
  on(event: 'message', cb: (channel: string, message: string) => void): void;
  on(event: 'error', cb: (err: Error) => void): void;
  set(key: string, value: string, ex?: 'EX', ttlSeconds?: number): Promise<unknown>;
  get(key: string): Promise<string | null>;
  del(key: string): Promise<number>;
  quit(): Promise<unknown>;
  duplicate(): RedisLike;
};

type Listener = (message: string) => void;

@Injectable()
export class RedisPubSubService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RedisPubSubService.name);
  /** In-process bus — always present (fallback + local fast-path). */
  private readonly local = new EventEmitter();
  /** Connection used to PUBLISH and run KV ops; null until/unless Redis wired. */
  private pub: RedisLike | null = null;
  /** Dedicated SUBSCRIBE connection (ioredis requires a separate one). */
  private sub: RedisLike | null = null;
  /** Channels this replica has asked Redis to subscribe to (idempotent). */
  private readonly subscribed = new Set<string>();
  /**
   * Channels a caller has subscribed to, regardless of whether Redis was
   * connected yet. `subscribe()` may run during bootstrap BEFORE the async
   * `onModuleInit` connect completes (e.g. a guard wiring a channel at
   * module-init) — in that window `this.sub` is still null, so the Redis-level
   * SUBSCRIBE would be silently skipped and this replica would never receive
   * cross-pod frames on that channel. We record every desired channel here and
   * flush them once the subscriber connection is up.
   */
  private readonly desiredChannels = new Set<string>();

  constructor(private readonly config: AppConfigService) {
    this.local.setMaxListeners(0);
  }

  async onModuleInit(): Promise<void> {
    const url = this.config.redisUrl?.trim();
    if (!url) {
      this.logger.log('REDIS_URL not set — realtime fanout uses in-process bus (single replica).');
      return;
    }
    try {
      // Lazy, optional import: a missing `ioredis` must not break the build or
      // bootstrap. The specifier is built indirectly so the type-checker does not
      // require the module to be present at compile time (it is a runtime dep,
      // declared in package.json and installed by CI/deploy `npm install`).
      const moduleName = 'ioredis';
      const dynamicImport = new Function('m', 'return import(m)') as (
        m: string,
      ) => Promise<unknown>;
      const mod = (await dynamicImport(moduleName).catch(() => null)) as
        | { default?: new (url: string) => RedisLike }
        | (new (url: string) => RedisLike)
        | null;
      if (!mod) {
        this.logger.warn('ioredis is not installed — falling back to in-process bus.');
        return;
      }
      const Redis = (typeof mod === 'function' ? mod : mod.default) as new (
        url: string,
      ) => RedisLike;
      this.pub = new Redis(url);
      this.sub = this.pub.duplicate();
      this.pub.on('error', (e) => this.logger.error(`Redis publisher error: ${e.message}`));
      this.sub.on('error', (e) => this.logger.error(`Redis subscriber error: ${e.message}`));
      this.sub.on('message', (channel, message) => this.local.emit(channel, message));
      // Flush any channels subscribed BEFORE the connection came up so their
      // Redis-level SUBSCRIBE is issued now (see `desiredChannels`).
      for (const channel of this.desiredChannels) {
        this.registerRedisSubscription(channel);
      }
      this.logger.log('Redis Pub/Sub connected — cross-replica realtime fanout enabled.');
    } catch (e) {
      this.pub = null;
      this.sub = null;
      this.logger.warn(
        `Redis connect failed (${(e as Error).message}) — falling back to in-process bus.`,
      );
    }
  }

  async onModuleDestroy(): Promise<void> {
    await Promise.allSettled([this.pub?.quit(), this.sub?.quit()]);
  }

  /** Publish a JSON-serializable payload to a channel (local + cross-replica). */
  publish(channel: string, payload: unknown): void {
    const message = typeof payload === 'string' ? payload : JSON.stringify(payload);
    // Local fast-path so the publishing replica delivers without a round-trip.
    this.local.emit(channel, message);
    if (this.pub) {
      void this.pub.publish(channel, message).catch((e) => {
        this.logger.error(`Redis publish ${channel} failed: ${(e as Error).message}`);
      });
    }
  }

  /**
   * Subscribe to a channel. Returns an unsubscribe function (call on connection
   * close). Registers the channel with Redis once per replica; the in-process
   * listener receives both local and cross-replica messages.
   */
  subscribe(channel: string, listener: Listener): () => void {
    this.local.on(channel, listener);
    this.desiredChannels.add(channel);
    // Register with Redis now if connected; otherwise `onModuleInit` flushes it
    // from `desiredChannels` once the subscriber connection is established.
    this.registerRedisSubscription(channel);
    return () => this.local.off(channel, listener);
  }

  /** Issue the Redis-level SUBSCRIBE for a channel (idempotent, no-op offline). */
  private registerRedisSubscription(channel: string): void {
    if (!this.sub || this.subscribed.has(channel)) return;
    this.subscribed.add(channel);
    void this.sub.subscribe(channel).catch((e) => {
      this.subscribed.delete(channel);
      this.logger.error(`Redis subscribe ${channel} failed: ${(e as Error).message}`);
    });
  }

  /** Set an ephemeral key with TTL (presence/open-state). No-op without Redis. */
  async setEx(key: string, value: string, ttlSeconds: number): Promise<void> {
    if (!this.pub) return;
    try {
      await this.pub.set(key, value, 'EX', ttlSeconds);
    } catch (e) {
      this.logger.error(`Redis setEx ${key} failed: ${(e as Error).message}`);
    }
  }

  /** Persist a key without TTL (last-seen timestamps, FR-CHAT-250). */
  async setPersist(key: string, value: string): Promise<void> {
    if (!this.pub) return;
    try {
      await this.pub.set(key, value);
    } catch (e) {
      this.logger.error(`Redis set ${key} failed: ${(e as Error).message}`);
    }
  }

  /** Read an ephemeral key; null when absent or Redis is not wired. */
  async get(key: string): Promise<string | null> {
    if (!this.pub) return null;
    try {
      return await this.pub.get(key);
    } catch (e) {
      this.logger.error(`Redis get ${key} failed: ${(e as Error).message}`);
      return null;
    }
  }

  /** Delete an ephemeral key (open-state on close). No-op without Redis. */
  async del(key: string): Promise<void> {
    if (!this.pub) return;
    try {
      await this.pub.del(key);
    } catch (e) {
      this.logger.error(`Redis del ${key} failed: ${(e as Error).message}`);
    }
  }

  /** True when a real Redis transport is active (multi-replica safe). */
  get redisEnabled(): boolean {
    return this.pub !== null;
  }
}
