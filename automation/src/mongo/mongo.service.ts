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
   * Contract §6 — project-scoped indexes (project_id first field, NFR-MAUT-6).
   * Idempotent: createIndex is a no-op when the index already exists.
   */
  private async ensureIndexes(): Promise<void> {
    try {
      await Promise.all([
        this.rules().createIndex({ project_id: 1, state: 1 }),
        this.rules().createIndex({ project_id: 1, trigger_type: 1, state: 1 }),
        this.rules().createIndex({ project_id: 1, updated_at: -1 }),
        // FR-MAUT-15: unique idempotency claim (sparse — legacy rows lack the key).
        this.executions().createIndex(
          { idempotency_key: 1 },
          { unique: true, sparse: true },
        ),
        this.executions().createIndex({ project_id: 1, rule_id: 1, created_at: -1 }),
        this.executions().createIndex({ project_id: 1, status: 1, created_at: -1 }),
        this.executions().createIndex({ project_id: 1, entity_type: 1, entity_id: 1 }),
        this.executions().createIndex({ project_id: 1, action_types: 1, created_at: -1 }),
        // NFR-070: journal retention — BSON Date anchor (created_at is epoch ms).
        this.executions().createIndex(
          { created_dt: 1 },
          { expireAfterSeconds: 60 * 60 * 24 * 90 },
        ),
        this.eventHooks().createIndex({ project_id: 1, created_at: -1 }),
        // TTL (TODO-335): MUST target a BSON Date field — `created_at` is a
        // Date.now() number and Mongo TTL silently never expires non-Date values.
        this.eventHooks().createIndex({ created_dt: 1 }, { expireAfterSeconds: 60 * 60 * 24 * 30 }),
        this.connections().createIndex({ project_id: 1, name: 1 }, { unique: true }),
        this.dlq().createIndex({ project_id: 1, status: 1 }),
        // TODO-041: the auto-retry sweeper selects on (status, next_retry_at).
        this.dlq().createIndex({ status: 1, next_retry_at: 1 }),
        this.dlq().createIndex({ next_retry_at: 1 }),
        // …and on (status, updated_at) for the lease reclaim of rows orphaned in
        // `retrying` by a runner that died mid-dispatch.
        this.dlq().createIndex({ status: 1, updated_at: 1 }),
        // Effect ledger: the unique index is the at-most-once claim; the TTL
        // index reaps rows a week after the retry ladder can no longer fire.
        this.actionEffects().createIndex({ effect_key: 1 }, { unique: true }),
        this.actionEffects().createIndex({ expires_at: 1 }, { expireAfterSeconds: 0 }),
        // Final-action deliveries (FR-ORDERS-270): one doc per business
        // idempotencyKey — the unique index is the exactly-once claim.
        this.finalActions().createIndex({ idempotency_key: 1 }, { unique: true }),
        this.finalActions().createIndex({ project_id: 1, order_id: 1, created_at: -1 }),
        // NFR-070: final-action journal retention (90d, same window as executions).
        this.finalActions().createIndex(
          { created_dt: 1 },
          { expireAfterSeconds: 60 * 60 * 24 * 90 },
        ),
        // FR-AUTOM-410: transactional outbox relay indexes.
        this.outbox().createIndex({ status: 1, createdAt: 1 }),
        this.outbox().createIndex({ createdAt: 1 }, { expireAfterSeconds: 60 * 60 * 24 * 7 }),
      ]);
    } catch {
      // Index creation is best-effort at boot; a conflicting legacy index must
      // not crash the service. Surfaced via Mongo logs, not fatal here.
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

  rules(): Collection {
    return this.db.collection('automation_rules');
  }

  executions(): Collection {
    return this.db.collection('automation_rule_executions');
  }

  eventHooks(): Collection {
    return this.db.collection('automation_event_hooks');
  }

  connections(): Collection {
    return this.db.collection('automation_connections');
  }

  dlq(): Collection {
    return this.db.collection('automation_dlq');
  }

  /**
   * Order final-action delivery journal (FR-ORDERS-270): per-idempotencyKey
   * state (`running`/`succeeded`/`failed`), per-attempt claims and the attempt
   * log the `crm.order.final_action_*` answer events are built from.
   */
  finalActions(): Collection {
    return this.db.collection('automation_final_actions');
  }

  /**
   * At-most-once ledger for action effects the target domain cannot dedup
   * (`send_notification`). One row per `<execution>:<action>:<retry generation>`;
   * the unique index IS the claim. See {@link EffectLedger}.
   */
  actionEffects(): Collection {
    return this.db.collection('automation_action_effects');
  }

  async healthPing(): Promise<void> {
    await this.db.admin().ping();
  }

  /** Underlying client (sessions / transactions — outbox FR-AUTOM-410). */
  getClient(): MongoClient {
    return this.client;
  }

  /** Transactional event outbox for rule mutations. */
  outbox(): Collection<OutboxRowDoc> {
    return this.db.collection<OutboxRowDoc>('automation_event_outbox');
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
