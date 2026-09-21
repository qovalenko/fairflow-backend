import { Injectable, Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { MongoClient, Db } from 'mongodb';
import { type IdempotencyRecord } from '@fairflow/shared';
import { AppConfigService } from '../config/app-config.service';

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
   * stays best-effort (never triggers a retry — see ensureIndexes rationale).
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
        // Best-effort: index creation must never crash boot (would put the gRPC
        // listener into a crash-loop, e.g. on legacy duplicate order numbers).
        await this.ensureIndexes().catch((err: unknown) => {
          this.logger.warn(
            { err: (err as Error)?.message },
            'ensureIndexes failed (continuing without some indexes)',
          );
        });
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

  orderTypes() {
    return this.getDb().collection('crm_order_types');
  }

  orders() {
    return this.getDb().collection('crm_orders');
  }

  /** Mutation idempotency ledger (P2.d) — one row per deduplicated create/merge/import. */
  idempotencyKeys() {
    return this.getDb().collection<IdempotencyRecord>('idempotency_keys');
  }

  /**
   * Per-project monotonic order-number sequences (A4). One doc per project id;
   * `findOneAndUpdate {$inc}` hands out gap-free numbers atomically, replacing
   * the collision-prone `ORD-${Date.now()}` scheme.
   */
  orderCounters() {
    return this.getDb().collection<OrderCounterDoc>('crm_order_counters');
  }

  /**
   * Allocate the next order number for a project atomically. `upsert` seeds the
   * sequence at 1 on first use; the `$inc` is a single-document update so it is
   * safe under concurrency without a transaction.
   */
  async nextOrderNumber(projectId: string): Promise<number> {
    const doc = await this.orderCounters().findOneAndUpdate(
      { _id: projectId },
      { $inc: { seq: 1 } },
      { upsert: true, returnDocument: 'after' },
    );
    return doc?.seq ?? 1;
  }

  /**
   * Idempotently create the collection indexes this service relies on
   * (audit #5, A4, #4). Safe to call on every boot — Mongo no-ops on identical
   * specs. Each index is best-effort: a single failure must not abort the rest
   * or crash onModuleInit (see caller). The unique `(projectId, number)` index
   * is preceded by a legacy-duplicate dedup so it can be built on live data that
   * still carries collision-prone `ORD-${Date.now()}` numbers.
   */
  private async ensureIndexes(): Promise<void> {
    this.getDb(); // connectivity guard: throws early if the client is not ready
    // Non-unique indexes first — never blocked by data.
    await this.createIndexBestEffort('crm_orders', {
      key: { projectId: 1, updatedAt: -1 },
      name: 'project_updatedAt',
    });
    await this.createIndexBestEffort('crm_orders', {
      key: { projectId: 1, dealId: 1 },
      name: 'project_deal',
    });
    // Reverse indexes for card/links aggregates (orders linked to a contact/company).
    await this.createIndexBestEffort('crm_orders', {
      key: { projectId: 1, contactId: 1 },
      name: 'project_contact',
    });
    await this.createIndexBestEffort('crm_orders', {
      key: { projectId: 1, companyId: 1 },
      name: 'project_company',
    });
    await this.createIndexBestEffort('crm_orders', {
      key: { projectId: 1, typeId: 1, stageId: 1 },
      name: 'project_type_stage',
    });
    // SENDING watchdog scan (cross-project janitor): partial ⇒ only the handful
    // of in-flight final-action sends are indexed.
    await this.createIndexBestEffort('crm_orders', {
      key: { status: 1, updatedAt: 1 },
      name: 'sending_watchdog',
      partialFilterExpression: { status: 'SENDING' },
    });
    // Unique order-number index: dedup legacy collisions first, then best-effort.
    await this.dedupOrderNumbers().catch((err: unknown) => {
      this.logger.warn(
        { err: (err as Error)?.message },
        'order-number dedup failed (unique index may not build)',
      );
    });
    await this.createIndexBestEffort('crm_orders', {
      key: { projectId: 1, number: 1 },
      name: 'uniq_project_number',
      unique: true,
    });
    await this.createIndexBestEffort('crm_order_types', {
      key: { projectId: 1 },
      name: 'project',
    });
    await this.createIndexBestEffort('crm_event_outbox', {
      key: { status: 1, createdAt: 1 },
      name: 'status_createdAt',
    });
    await this.createIndexBestEffort('crm_event_outbox', {
      key: { publishedAt: 1 },
      name: 'published_ttl',
      expireAfterSeconds: 7 * 24 * 60 * 60,
      partialFilterExpression: { status: 'published' },
    });
    // Pinned-revision lookup on every stage move (`moveOrder` reads the order's
    // frozen (projectId, orderTypeId, version) revision) — without this index the
    // hot path is a collection scan (TODO-415). Not unique: legacy data may hold
    // duplicate rows for one version and a failed unique build would drop the index.
    await this.createIndexBestEffort('crm_order_type_revisions', {
      key: { projectId: 1, orderTypeId: 1, version: -1 },
      name: 'project_type_version',
    });
    // Mutation idempotency ledger (P2.d): unique claim key + 24h TTL to reap keys.
    await this.createIndexBestEffort('idempotency_keys', {
      key: { projectId: 1, key: 1 },
      name: 'projectId_key_unique',
      unique: true,
    });
    await this.createIndexBestEffort('idempotency_keys', {
      key: { createdAt: 1 },
      name: 'createdAt_ttl',
      expireAfterSeconds: 24 * 60 * 60,
    });
  }

  /** Create a single index, swallowing+logging failures so boot cannot crash. */
  private async createIndexBestEffort(
    collection: string,
    spec: { key: Record<string, 1 | -1>; name: string } & Record<string, unknown>,
  ): Promise<void> {
    const { key, ...opts } = spec;
    try {
      await this.getDb().collection(collection).createIndex(key, opts);
    } catch (err) {
      this.logger.warn(
        { err: (err as Error)?.message, index: spec.name, collection },
        'failed to ensure index',
      );
    }
  }

  /**
   * Re-number legacy duplicate order numbers within each project so the unique
   * `(projectId, number)` index can be built. Keeps the first row per
   * (projectId, number) and re-issues fresh sequence numbers for the rest via
   * {@link nextOrderNumber}. Idempotent: once numbers are unique it finds none.
   */
  private async dedupOrderNumbers(): Promise<void> {
    const orders = this.getDb().collection('crm_orders');
    const dups = (await orders
      .aggregate([
        { $match: { number: { $ne: null } } },
        {
          $group: {
            _id: { projectId: '$projectId', number: '$number' },
            ids: { $push: '$_id' },
            count: { $sum: 1 },
          },
        },
        { $match: { count: { $gt: 1 } } },
      ])
      .toArray()) as { _id: { projectId: string; number: unknown }; ids: unknown[] }[];
    for (const group of dups) {
      const projectId = group._id.projectId;
      // Keep the first, re-number the remaining collisions.
      for (const dupId of group.ids.slice(1)) {
        const seq = await this.nextOrderNumber(projectId);
        await orders.updateOne(
          { _id: dupId as never },
          // updatedAt is stored as epoch millis across the whole domain (createOrder,
          // moveOrder, the SENDING watchdog cutoff and the `updatedAt:-1` sorts). A
          // `new Date()` here would be a BSON Date, which sorts BEFORE every number
          // and never matches the watchdog's `{ $lt: <number> }` cutoff (TODO-410).
          { $set: { number: `ORD-${String(seq).padStart(5, '0')}`, updatedAt: Date.now() } },
        );
      }
    }
    if (dups.length) {
      this.logger.warn(
        { groups: dups.length },
        'renumbered legacy duplicate order numbers before unique index',
      );
    }
  }

  /** Immutable order-type revisions (TO-BE, WM2). */
  orderTypeRevisions() {
    return this.getDb().collection('crm_order_type_revisions');
  }

  /**
   * Transactional event outbox (E3-01, RFC-4 §Р-4). The relay reads `pending`
   * rows from here and publishes them to RabbitMQ at-least-once (E3-02).
   */
  outbox() {
    return this.getDb().collection<OutboxRowDoc>('crm_event_outbox');
  }

  /** @deprecated alias of {@link outbox} (kept for compatibility). */
  eventOutbox() {
    return this.outbox();
  }

  async healthPing(): Promise<void> {
    await this.getDb().admin().ping();
  }
}

/** Per-project order-number sequence document (A4). `_id` is the project id. */
export interface OrderCounterDoc {
  _id: string;
  seq: number;
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
