import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Collection, Db, MongoClient } from 'mongodb';

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
   * boot (crash-loop) if Mongo was down at start; this self-heals. ensureIndexes
   * is best-effort (swallows internally), so it never triggers a retry.
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

  /**
   * Indexes for the immutable audit chain (E3-03):
   *  - unique (chainKey, seq) enforces append-only ordering (no two records may
   *    occupy the same chain position — protects the hash-chain invariant);
   *  - read indexes for entity/actor/trace queries (TZ §5.4);
   *  - TTL on processed_messages (7d) for the dedup ledger (TZ §5.3).
   */
  private async ensureIndexes(): Promise<void> {
    try {
      await this.auditEvents().createIndex({ chainKey: 1, seq: 1 }, { unique: true, sparse: true });
      await this.auditEvents().createIndex({ projectId: 1, entityType: 1, entityId: 1, createdAt: -1 });
      await this.auditEvents().createIndex({ projectId: 1, actorId: 1, createdAt: -1 });
      await this.auditEvents().createIndex({ projectId: 1, traceId: 1 });
      // Pending-claim takeover check (TODO-033): claimMessage() looks a message
      // up by idempotencyKey on re-delivery of a half-processed event.
      await this.auditEvents().createIndex({ idempotencyKey: 1 }, { sparse: true });
      await this.processedMessages().createIndex(
        { processedAt: 1 },
        { expireAfterSeconds: 7 * 24 * 60 * 60 },
      );
    } catch {
      // Index creation is best-effort on boot; conflicting legacy indexes must
      // not crash the service. Re-run on next deploy after cleanup.
    }
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

  async healthPing(): Promise<void> {
    await this.db.admin().ping();
  }

  auditEvents(): Collection {
    return this.db.collection('audit_events');
  }

  /** Per-scope hash-chain head (seq + last hash) — drives atomic seq allocation. */
  auditChainHeads(): Collection {
    return this.db.collection('audit_chain_heads');
  }

  /** Idempotent-consumer dedup ledger (`_id` = idempotencyKey|messageId, TTL 7d). */
  processedMessages(): Collection {
    return this.db.collection('processed_messages');
  }
}
