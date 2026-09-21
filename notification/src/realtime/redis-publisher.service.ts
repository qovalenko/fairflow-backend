import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';

/**
 * Publish-only Redis seam for the notification domain (P2.e, E3).
 *
 * The gateway holds the long-lived SSE connections and subscribes to the
 * per-user channel `notif:user:{userId}` (gateway `redis-pubsub.service.ts` +
 * `notification-stream.service.ts`). This service is the PUBLISHER side on the
 * domain: whenever the domain changes a user's unread state (materialize /
 * markRead / markAllRead) it publishes a tiny badge frame on the SAME channel so
 * the gateway can push an SSE `badge` event to the browser (≤ 3 s, NFR-MNOT-2)
 * instead of the client polling.
 *
 * Transport resolution mirrors the gateway seam:
 *  - When `REDIS_URL` is set AND `ioredis` is installed, a publisher connection
 *    is opened; a frame published here reaches every gateway replica subscribed
 *    to the channel (multi-replica fanout, no sticky sessions).
 *  - When Redis is not configured/installed/reachable, it degrades to a pure
 *    no-op with a one-time warn: the in-app feed stays authoritative (Mongo) and
 *    SSE simply degrades to client polling (NFR-MNOT-2). `ioredis` is imported
 *    lazily so a missing native module never breaks `nest build`.
 *
 * Publish-only: the domain never subscribes (no SSE connections live here).
 */

type RedisLike = {
  publish(channel: string, message: string): Promise<number>;
  quit(): Promise<unknown>;
  on(event: 'error', cb: (err: Error) => void): void;
};

@Injectable()
export class RedisPublisherService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RedisPublisherService.name);
  /** Connection used to PUBLISH; null until/unless Redis is wired. */
  private pub: RedisLike | null = null;
  /** Guard so a repeated publish while Redis is down logs the warning once. */
  private degradedWarned = false;

  async onModuleInit(): Promise<void> {
    const url = process.env.REDIS_URL?.trim();
    if (!url) {
      this.logger.log(
        'REDIS_URL not set — SSE badge signals disabled (feed stays authoritative, client polls; NFR-MNOT-2).',
      );
      return;
    }
    try {
      // Lazy, optional import: a missing `ioredis` must not break the build or
      // bootstrap. The specifier is built indirectly so the type-checker does not
      // require the module at compile time (runtime dep, declared in package.json,
      // installed by CI/deploy `npm install`). Same philosophy as the gateway seam.
      const moduleName = 'ioredis';
      const dynamicImport = new Function('m', 'return import(m)') as (
        m: string,
      ) => Promise<unknown>;
      const mod = (await dynamicImport(moduleName).catch(() => null)) as
        | { default?: new (url: string) => RedisLike }
        | (new (url: string) => RedisLike)
        | null;
      if (!mod) {
        this.logger.warn('ioredis is not installed — SSE badge signals disabled (no-op).');
        return;
      }
      const Redis = (typeof mod === 'function' ? mod : mod.default) as new (
        url: string,
      ) => RedisLike;
      this.pub = new Redis(url);
      this.pub.on('error', (e) => this.logger.error(`Redis publisher error: ${e.message}`));
      this.logger.log('Redis publisher connected — SSE badge fanout enabled.');
    } catch (e) {
      this.pub = null;
      this.logger.warn(
        `Redis connect failed (${(e as Error).message}) — SSE badge signals disabled (no-op).`,
      );
    }
  }

  async onModuleDestroy(): Promise<void> {
    await Promise.allSettled([this.pub?.quit()]);
  }

  /**
   * Publish a JSON-serializable payload to a channel. Fail-soft: when Redis is
   * not wired this is a no-op (warns once); a publish error is logged, never
   * thrown — a realtime hint must never fail the underlying gRPC mutation.
   */
  publish(channel: string, payload: unknown): void {
    if (!this.pub) {
      if (!this.degradedWarned) {
        this.degradedWarned = true;
        this.logger.debug(
          `Redis not wired — dropping badge signal on ${channel} (SSE degrades to polling).`,
        );
      }
      return;
    }
    const message = typeof payload === 'string' ? payload : JSON.stringify(payload);
    void this.pub.publish(channel, message).catch((e) => {
      this.logger.error(`Redis publish ${channel} failed: ${(e as Error).message}`);
    });
  }

  /** True when a real Redis transport is active. */
  get redisEnabled(): boolean {
    return this.pub !== null;
  }
}
