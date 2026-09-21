import { Injectable, Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { Collection, Db, MongoClient } from 'mongodb';
import { type IdempotencyRecord } from '@fairflow/shared';
import { AppConfigService } from '../config/app-config.service';

/** Retention for published outbox rows before the TTL monitor purges them (#4): 7 days. */
const OUTBOX_PUBLISHED_TTL_SECONDS = 7 * 24 * 60 * 60;

/** Retention for mutation idempotency ledger rows (P2.d): 24h ≥ retry window. */
const IDEMPOTENCY_TTL_SECONDS = 24 * 60 * 60;

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
        await this.ensureActivityIndexes();
        await this.ensureOutboxIndexes();
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
   * Activity collection indexes (#5). Best-effort/idempotent — a failure here
   * must not block startup of the gRPC/HTTP listeners.
   *
   * - `{ projectId, status, dueDate }` backs the overdue push-down (list with
   *   status $nin TERMINAL + dueDate range, sort dueDate).
   * - `{ projectId, 'links.entityId' }` backs the linked-entity filter.
   * - `{ projectId, assigneeId, dueDate }` backs the assignee+due list/sort.
   */
  private async ensureActivityIndexes(): Promise<void> {
    if (!this.db) return;
    const coll = this.db.collection('crm_activities');
    const specs: { key: Record<string, 1 | -1>; name: string }[] = [
      { key: { projectId: 1, status: 1, dueDate: 1 }, name: 'project_status_due' },
      { key: { projectId: 1, 'links.entityId': 1 }, name: 'project_link_entity' },
      { key: { projectId: 1, assigneeId: 1, dueDate: 1 }, name: 'project_assignee_due' },
    ];
    for (const spec of specs) {
      try {
        await coll.createIndex(spec.key, { name: spec.name });
      } catch (err) {
        this.logger.warn(
          { err: (err as Error).message, index: spec.name },
          'failed to ensure activity index',
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
    const coll = this.db.collection('_outbox');
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

  activities(): Collection {
    return this.getDb().collection('crm_activities');
  }

  /**
   * Mutation idempotency ledger indexes (NFR-ACT-100): unique `{ projectId, key }`
   * plus a 24h TTL on `createdAt`. Best-effort — must not block startup.
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
        { err: (err as Error).message },
        'failed to ensure idempotency unique index',
      );
    }
    try {
      await coll.createIndex(
        { createdAt: 1 },
        { name: 'ttl_createdAt', expireAfterSeconds: IDEMPOTENCY_TTL_SECONDS },
      );
    } catch (err) {
      this.logger.warn({ err: (err as Error).message }, 'failed to ensure idempotency TTL index');
    }
  }

  /** Mutation idempotency ledger (NFR-ACT-100) — one row per deduplicated create. */
  idempotencyKeys(): Collection<IdempotencyRecord> {
    return this.getDb().collection<IdempotencyRecord>('idempotency_keys');
  }

  /** Transactional-outbox collection (E3-01, RFC-4 §Р-4). */
  outbox(): Collection<OutboxRowDoc> {
    return this.getDb().collection<OutboxRowDoc>('_outbox');
  }

  /** Underlying client (for sessions / transactions). */
  getClient(): MongoClient {
    if (!this.client) throw new Error('MongoDB not connected');
    return this.client;
  }

  async healthPing(): Promise<void> {
    await this.getDb().admin().ping();
  }
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
