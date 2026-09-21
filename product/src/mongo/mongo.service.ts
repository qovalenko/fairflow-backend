import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Collection, Db, MongoClient } from 'mongodb';
import { type IdempotencyRecord } from '@fairflow/shared';
import { AppConfigService } from '../config/app-config.service';

/** Retention for published outbox rows before the TTL monitor purges them (#4): 7 days. */
const OUTBOX_PUBLISHED_TTL_SECONDS = 7 * 24 * 60 * 60;

@Injectable()
export class MongoService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(MongoService.name);
  private client: MongoClient | null = null;
  private db: Db | null = null;
  // Retry-loop control (P0-4): flag + timer/resolver so onModuleDestroy can stop
  // the backoff loop cleanly without leaving a dangling timer (jest/graceful shutdown).
  private destroyed = false;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private retryResolve: (() => void) | null = null;

  constructor(private readonly config: AppConfigService) {}

  async onModuleInit(): Promise<void> {
    await this.connectWithRetry();
  }

  /**
   * Connect to MongoDB with exponential backoff (1s → 2s → 4s … cap 30s), retrying
   * forever until success or onModuleDestroy (P0-4). A one-shot connect crashed
   * boot (crash-loop) if Mongo was down at start; this self-heals. Index setup
   * failures also trigger a retry of the whole cycle.
   */
  private async connectWithRetry(): Promise<void> {
    const url = this.config.databaseUrl;
    let attempt = 0;
    let delayMs = 1_000;
    while (!this.destroyed) {
      attempt += 1;
      const client = new MongoClient(url);
      try {
        await client.connect();
        if (this.destroyed) {
          await client.close().catch(() => undefined);
          return;
        }
        this.client = client;
        this.db = client.db();
        this.logger.log('MongoDB connected');
        await this.ensureProductIndexes();
        await this.ensureOutboxIndexes();
        await this.ensureUsageProcessedIndexes();
        await this.ensureIdempotencyIndexes();
        return;
      } catch (err) {
        await client.close().catch(() => undefined);
        this.client = null;
        this.db = null;
        if (this.destroyed) return;
        this.logger.warn(
          { err: (err as Error).message, attempt, delayMs },
          `MongoDB connection attempt ${attempt} failed; retrying in ${delayMs}ms`,
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
   * Product collection indexes (#5). Best-effort/idempotent — a failure here
   * must not block startup of the gRPC/HTTP listeners.
   *
   * - `{ projectId, updatedAt }` backs the project-scoped list (filter projectId,
   *   default sort updatedAt desc).
   * - `{ projectId, status }` backs the status filter and the `countDocuments`
   *   usage counters (per-project total / active).
   */
  private async ensureProductIndexes(): Promise<void> {
    if (!this.db) return;
    const coll = this.db.collection('crm_products');
    const specs: { key: Record<string, 1 | -1>; name: string }[] = [
      { key: { projectId: 1, updatedAt: -1 }, name: 'project_updated' },
      { key: { projectId: 1, status: 1 }, name: 'project_status' },
    ];
    for (const spec of specs) {
      try {
        await coll.createIndex(spec.key, { name: spec.name });
      } catch (err) {
        this.logger.warn(
          { err: (err as Error).message, index: spec.name },
          'failed to ensure product index',
        );
      }
    }
  }

  /**
   * Outbox indexes (#4): `{ status, createdAt }` backs the relay's `fetchPending`
   * (find status=pending sort createdAt), plus a partial TTL on `publishedAt` to
   * auto-purge published rows after a retention window.
   */
  private async ensureOutboxIndexes(): Promise<void> {
    if (!this.db) return;
    const coll = this.db.collection('crm_event_outbox');
    try {
      await coll.createIndex({ status: 1, createdAt: 1 }, { name: 'status_created' });
    } catch (err) {
      this.logger.warn({ err: (err as Error).message }, 'failed to ensure outbox status index');
    }
    try {
      await coll.createIndex(
        { publishedAt: 1 },
        {
          name: 'ttl_published',
          expireAfterSeconds: OUTBOX_PUBLISHED_TTL_SECONDS,
          partialFilterExpression: { status: 'published' },
        },
      );
    } catch (err) {
      this.logger.warn({ err: (err as Error).message }, 'failed to ensure outbox TTL index');
    }
  }

  /**
   * Listener dedup journal index (FR-PRODUCTS-220 / NFR-MPRD-3): unique on
   * `dedupKey` so markProcessed loses the race on redelivery instead of
   * double-counting.
   */
  private async ensureUsageProcessedIndexes(): Promise<void> {
    if (!this.db) return;
    const coll = this.db.collection('crm_product_usage_processed');
    try {
      await coll.createIndex({ dedupKey: 1 }, { name: 'dedupKey_unique', unique: true });
    } catch (err) {
      this.logger.warn(
        { err: (err as Error).message, index: 'dedupKey_unique' },
        'failed to ensure usage-processed index',
      );
    }
  }

  /**
   * Mutation idempotency ledger (CANON §5.1 Idempotency-Key): unique claim key
   * + 24h TTL, same pattern as contact/orders.
   */
  private async ensureIdempotencyIndexes(): Promise<void> {
    if (!this.db) return;
    const coll = this.db.collection('idempotency_keys');
    try {
      await coll.createIndex(
        { projectId: 1, key: 1 },
        { name: 'projectId_key_unique', unique: true },
      );
    } catch (err) {
      this.logger.warn(
        { err: (err as Error).message, index: 'projectId_key_unique' },
        'failed to ensure idempotency unique index',
      );
    }
    try {
      await coll.createIndex(
        { createdAt: 1 },
        { name: 'createdAt_ttl', expireAfterSeconds: 24 * 60 * 60 },
      );
    } catch (err) {
      this.logger.warn(
        { err: (err as Error).message, index: 'createdAt_ttl' },
        'failed to ensure idempotency TTL index',
      );
    }
  }

  async onModuleDestroy(): Promise<void> {
    this.destroyed = true;
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    if (this.retryResolve) {
      this.retryResolve();
      this.retryResolve = null;
    }
    if (this.client) {
      await this.client.close().catch(() => undefined);
      this.client = null;
      this.db = null;
    }
  }

  getDb(): Db {
    if (!this.db) throw new Error('MongoDB not connected');
    return this.db;
  }

  /** Underlying client (for sessions / transactions — outbox E3-01). */
  getClient(): MongoClient {
    if (!this.client) throw new Error('MongoDB not connected');
    return this.client;
  }

  products(): Collection {
    return this.getDb().collection('crm_products');
  }

  /**
   * FR-PRODUCTS-230: READ-ONLY views of the deal/order collections that live in
   * the same CRM Mongo database. Used solely by the usage breakdown
   * (`GetProductUsage`), which has to group the product's links by department and
   * by owner — a number no counter on the product row can carry (the counters are
   * scalars). Никаких записей сюда: владельцы этих коллекций — pipe и orders,
   * счётчики продукта по-прежнему живут на их событиях (usage.listener).
   */
  deals(): Collection {
    return this.getDb().collection('crm_deals');
  }

  orders(): Collection {
    return this.getDb().collection('crm_orders');
  }

  /**
   * Transactional event outbox (E3-01, RFC-4 §Р-4). The relay reads `pending`
   * rows from here and publishes them to RabbitMQ at-least-once (E3-02 / I1b).
   */
  outbox(): Collection<OutboxRowDoc> {
    return this.getDb().collection<OutboxRowDoc>('crm_event_outbox');
  }

  /**
   * Inbound listener dedup journal (NFR-MPRD-3, contract §6.2). One row per
   * processed envelope dedup-key; a unique index makes a second insert fail, so
   * the at-least-once bus can redeliver without double-counting catalog counters.
   */
  usageProcessed(): Collection<ProcessedMessageDoc> {
    return this.getDb().collection<ProcessedMessageDoc>('crm_product_usage_processed');
  }

  /** Mutation idempotency ledger (P2.d / CANON §5.1). */
  idempotencyKeys(): Collection<IdempotencyRecord> {
    return this.getDb().collection<IdempotencyRecord>('idempotency_keys');
  }

  async healthPing(): Promise<void> {
    await this.getDb().admin().ping();
  }
}

/** One consumed-message marker for listener idempotency (NFR-MPRD-3). */
export interface ProcessedMessageDoc {
  _id?: import('mongodb').ObjectId;
  /** Envelope dedup-key (`idempotencyKey ?? messageId`) — unique. */
  dedupKey: string;
  routingKey: string;
  projectId?: string;
  processedAt: Date;
}

/** Stored shape of a transactional-outbox row (mirrors `OutboxRow` from shared). */
export interface OutboxRowDoc {
  _id?: import('mongodb').ObjectId;
  messageId: string;
  routingKey: string;
  projectId?: string;
  status: 'pending' | 'published' | 'failed';
  attempts: number;
  envelope: unknown;
  lastError?: string;
  createdAt: Date;
  updatedAt: Date;
  publishedAt?: Date;
}
