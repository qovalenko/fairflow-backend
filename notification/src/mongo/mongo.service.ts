import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Collection, Db, MongoClient } from 'mongodb';
import {
  notificationExpiresAt,
  notificationRetentionTtlSeconds,
  NOTIFICATION_RETENTION_MS,
} from '../notification/notification-retention';

export const NOTIFICATION_RETENTION_TTL_INDEX = 'notification_retention_ttl';

@Injectable()
export class MongoService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(MongoService.name);
  private client!: MongoClient;
  private db!: Db;
  // Retry-loop control (P0-4): flag + timer/resolver so onModuleDestroy can stop
  // the backoff loop cleanly without leaving a dangling timer (jest/graceful shutdown).
  private destroyed = false;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private retryResolve: (() => void) | null = null;

  constructor(private readonly config: ConfigService) {}

  async onModuleInit() {
    await this.connectWithRetry();
  }

  /**
   * Connect to MongoDB with exponential backoff (1s → 2s → 4s … cap 30s), retrying
   * forever until success or onModuleDestroy (P0-4). A one-shot connect crashed
   * boot (crash-loop) if Mongo was down at start; this self-heals. Index setup
   * failures also trigger a retry of the whole cycle.
   */
  private async connectWithRetry(): Promise<void> {
    const uri = this.config.get<string>('MONGODB_URI');
    if (!uri) {
      throw new Error('MONGODB_URI is required');
    }
    let attempt = 0;
    let delayMs = 1_000;
    while (!this.destroyed) {
      attempt += 1;
      const client = new MongoClient(uri);
      try {
        await client.connect();
        if (this.destroyed) {
          await client.close().catch(() => undefined);
          return;
        }
        this.client = client;
        this.db = client.db();
        this.logger.log('MongoDB connected');
        await this.ensureIndexes();
        return;
      } catch (err) {
        await client.close().catch(() => undefined);
        if (this.destroyed) return;
        this.logger.warn(
          `MongoDB connection attempt ${attempt} failed; retrying in ${delayMs}ms: ${(err as Error).message}`,
        );
        await this.wait(delayMs);
        delayMs = Math.min(delayMs * 2, 30_000);
      }
    }
  }

  /** Interruptible backoff sleep: onModuleDestroy clears the timer and resolves. */
  private wait(ms: number): Promise<void> {
    return new Promise((resolve) => {
      this.retryResolve = resolve;
      this.retryTimer = setTimeout(() => {
        this.retryTimer = null;
        this.retryResolve = null;
        resolve();
      }, ms);
    });
  }

  private async ensureIndexes(): Promise<void> {
    // Feed + counter (contract §6.1). Owner-scope indexed gate (V-8).
    await this.notifications().createIndex({
      project_id: 1,
      user_id: 1,
      readed: 1,
      created_at: -1,
    });
    // Idempotency for bus materialization (V-3). Sparse: direct send has no message_id.
    await this.notifications().createIndex(
      { user_id: 1, message_id: 1 },
      { unique: true, sparse: true },
    );
    // Feed/badge filter now leads with user_id ($or over project rows + personal
    // scope_kind='user' rows — TODO-205); the project_id-first index above is not
    // usable for it, so without this index every badge poll is a collection scan.
    await this.notifications().createIndex({ user_id: 1, readed: 1, created_at: -1 });
    // High-frequency collapse lookup (FR-MNOT-19).
    await this.notifications().createIndex(
      { user_id: 1, collapse_key: 1, created_at: -1 },
      { sparse: true },
    );
    // FR-NOTIF-070: hard-delete notifications after the retention window (90d default).
    await this.notifications().createIndex(
      { expires_at: 1 },
      { expireAfterSeconds: notificationRetentionTtlSeconds(), name: NOTIFICATION_RETENTION_TTL_INDEX },
    );
    // Legacy rows written before expires_at existed: derive from numeric created_at once.
    await this.notifications().updateMany(
      { expires_at: { $exists: false }, created_at: { $type: 'number' } },
      [{ $set: { expires_at: { $toDate: { $add: ['$created_at', NOTIFICATION_RETENTION_MS] } } } }],
    ).catch((err) => {
      this.logger.warn(`notification retention backfill skipped: ${(err as Error).message}`);
    });
    // Per-user preferences (project-less). Unique on user_id.
    await this.preferences().createIndex({ user_id: 1 }, { unique: true });
    // Activity reminder scheduler queue (TODO-116): due-scan by status+fire_at.
    await this.scheduledReminders().createIndex({ status: 1, fire_at: 1 });
    await this.scheduledReminders().createIndex({ dedup_key: 1 }, { unique: true });
    await this.scheduledReminders().createIndex({ reminder_key: 1, status: 1 });
  }

  async onModuleDestroy() {
    this.destroyed = true;
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    if (this.retryResolve) {
      this.retryResolve();
      this.retryResolve = null;
    }
    await this.client?.close().catch(() => undefined);
  }

  notifications(): Collection {
    return this.db.collection('notification_messages');
  }

  preferences(): Collection {
    return this.db.collection('notification_prefs');
  }

  scheduledReminders(): Collection {
    return this.db.collection('notification_scheduled_reminders');
  }

  async healthPing(): Promise<void> {
    await this.db.admin().ping();
  }
}
