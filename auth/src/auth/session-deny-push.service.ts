import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { sessionDenyRedisKey, sessionDenyTtlSeconds } from '@fairflow/shared';
import type { SessionRevokeReason } from '../auth/session-revoke-reason';

type RedisLike = {
  setex(key: string, seconds: number, value: string): Promise<unknown>;
  on(event: string, cb: () => void): void;
};

/**
 * Push revoked session jtis into Redis so gateway replicas see revocation
 * immediately (FR-AUTH-160), without waiting for the next DB-backed
 * ValidateSession round-trip.
 */
@Injectable()
export class SessionDenyPushService implements OnModuleDestroy {
  private readonly logger = new Logger(SessionDenyPushService.name);
  private client: RedisLike | null = null;
  private connecting: Promise<RedisLike | null> | null = null;

  private async getClient(): Promise<RedisLike | null> {
    const url = process.env.REDIS_URL?.trim();
    if (!url) return null;
    if (this.client) return this.client;
    if (!this.connecting) {
      this.connecting = this.connect(url);
    }
    return this.connecting;
  }

  private async connect(url: string): Promise<RedisLike | null> {
    try {
      const moduleName = 'ioredis';
      const mod = await import(moduleName).catch(() => null);
      if (!mod) {
        this.logger.warn('ioredis is not installed — session deny-list push disabled.');
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
      this.logger.warn(`Redis connect failed for deny-list push: ${(e as Error).message}`);
      return null;
    }
  }

  async pushDenied(
    jti: string,
    expiresAt: Date | null | undefined,
    reason: SessionRevokeReason = 'session_revoked',
  ): Promise<void> {
    const id = jti?.trim();
    if (!id) return;
    const client = await this.getClient();
    if (!client) return;
    const ttl = sessionDenyTtlSeconds(expiresAt);
    try {
      await client.setex(sessionDenyRedisKey(id), ttl, reason);
    } catch (e) {
      this.logger.warn(`deny-list push failed for jti=${id}: ${(e as Error).message}`);
    }
  }

  async pushDeniedMany(
    rows: Array<{ tokenId: string | null | undefined; expiresAt: Date | null | undefined }>,
    reason: SessionRevokeReason = 'session_revoked',
  ): Promise<void> {
    for (const row of rows) {
      if (!row.tokenId) continue;
      await this.pushDenied(row.tokenId, row.expiresAt, reason);
    }
  }

  async onModuleDestroy(): Promise<void> {
    const c = this.client as { disconnect?: () => void } | null;
    c?.disconnect?.();
    this.client = null;
    this.connecting = null;
  }
}
