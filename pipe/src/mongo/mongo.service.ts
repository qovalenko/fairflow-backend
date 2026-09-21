import { Injectable, Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { MongoClient, Db } from 'mongodb';
import { abacMaterializedIndexSpecs, type IdempotencyRecord } from '@fairflow/shared';
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
        await this.ensureAbacIndexes();
        await this.ensureQueryIndexes();
        await this.ensureOutboxIndexes();
        await this.ensureDriftInboxIndexes();
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
   * Drift-listener idempotency ledger indexes: a unique `messageId` for dedup and
   * a 7-day TTL on `processedAt` to reap processed rows. Idempotent, best-effort.
   */
  private async ensureDriftInboxIndexes(): Promise<void> {
    if (!this.db) return;
    try {
      await this.db.command({
        createIndexes: 'crm_drift_inbox',
        indexes: [
          { key: { messageId: 1 }, name: 'messageId_unique', unique: true },
          { key: { processedAt: 1 }, name: 'processedAt_ttl', expireAfterSeconds: 604_800 },
        ],
      });
    } catch (err) {
      this.logger.warn({ err: (err as Error).message }, 'failed to ensure drift inbox indexes');
    }
  }

  /**
   * Mutation idempotency ledger indexes (P2.d): a unique `{ projectId, key }` so a
   * retried create/merge/import claims the same row, plus a 24h TTL on `createdAt`
   * to reap stale keys. Idempotent and best-effort — must not block startup.
   */
  private async ensureIdempotencyIndexes(): Promise<void> {
    if (!this.db) return;
    try {
      await this.db.command({
        createIndexes: 'idempotency_keys',
        indexes: [
          { key: { projectId: 1, key: 1 }, name: 'projectId_key_unique', unique: true },
          { key: { createdAt: 1 }, name: 'createdAt_ttl', expireAfterSeconds: 86_400 },
        ],
      });
    } catch (err) {
      this.logger.warn({ err: (err as Error).message }, 'failed to ensure idempotency indexes');
    }
  }

  /**
   * Indexes backing the real query shapes of this service (#5). Every filter is
   * `{ projectId }`-prefixed (isolation boundary), so the compound indexes lead
   * with projectId. Idempotent and best-effort — must not block startup.
   */
  private async ensureQueryIndexes(): Promise<void> {
    if (!this.db) return;
    const specs: { key: Record<string, 1 | -1>; opts?: Record<string, unknown> }[] = [
      // listDeals default sort + kanban/dashboard scans.
      { key: { projectId: 1, updatedAt: -1 } },
      // listDeals/kanban stage filters.
      { key: { projectId: 1, pipelineId: 1, stageId: 1 } },
      // product delete-guard / CountDealsByProduct.
      { key: { projectId: 1, productId: 1 } },
      // assignee (visibility/own-only) filter.
      { key: { projectId: 1, assigneeId: 1 } },
      // Reverse indexes for card/links aggregates (deals of a contact/company).
      { key: { projectId: 1, contactId: 1 } },
      { key: { projectId: 1, companyId: 1 } },
      // Soft-delete predicate is in every list/read filter — partial keeps it lean.
      {
        key: { projectId: 1, deletedAt: 1 },
        opts: { partialFilterExpression: { deletedAt: { $type: 'date' } } },
      },
    ];
    for (const s of specs) {
      try {
        await this.db.command({
          createIndexes: 'crm_deals',
          indexes: [{ key: s.key, name: indexName(s.key), ...(s.opts ?? {}) }],
        });
      } catch (err) {
        this.logger.warn({ err: (err as Error).message }, 'failed to ensure crm_deals query index');
      }
    }
    for (const coll of ['crm_pipelines', 'crm_deal_sources']) {
      try {
        await this.db.command({
          createIndexes: coll,
          indexes: [{ key: { projectId: 1, id: 1 }, name: 'projectId_1_id_1' }],
        });
      } catch (err) {
        this.logger.warn({ err: (err as Error).message, coll }, 'failed to ensure lookup index');
      }
    }
  }

  /**
   * Outbox indexes (#4): a `{ status, createdAt }` index backs the relay's pending
   * fetch, and a TTL on `publishedAt` reaps published rows so the collection does
   * not grow unbounded. Idempotent and best-effort.
   */
  private async ensureOutboxIndexes(): Promise<void> {
    if (!this.db) return;
    try {
      await this.db.command({
        createIndexes: '_outbox',
        indexes: [
          { key: { status: 1, createdAt: 1 }, name: 'status_1_createdAt_1' },
          // Reap published rows ~24h after publish (published rows carry publishedAt).
          {
            key: { publishedAt: 1 },
            name: 'publishedAt_ttl',
            expireAfterSeconds: 86_400,
            partialFilterExpression: { status: 'published' },
          },
        ],
      });
    } catch (err) {
      this.logger.warn({ err: (err as Error).message }, 'failed to ensure outbox indexes');
    }
  }

  /**
   * Materialized-ABAC indexes for deals (E2-05 / I2b, RFC-5 §1.3): one
   * project-scoped `{ projectId, <attr> }` index per declared materialized
   * attribute so the `compileMongo` ABAC fragment is index-backed. Idempotent
   * and best-effort — must not block startup.
   */
  private async ensureAbacIndexes(): Promise<void> {
    if (!this.db) return;
    const coll = this.db.collection('crm_deals');
    for (const spec of abacMaterializedIndexSpecs('deals')) {
      try {
        await coll.createIndex(spec.key, { name: spec.name, sparse: true });
      } catch (err) {
        this.logger.warn(
          { err: (err as Error).message, index: spec.name },
          'failed to ensure ABAC materialized index',
        );
      }
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

  pipelines() {
    return this.getDb().collection<PipelineDoc>('crm_pipelines');
  }

  dealSources() {
    return this.getDb().collection<DealSourceDoc>('crm_deal_sources');
  }

  deals() {
    return this.getDb().collection<DealDoc>('crm_deals');
  }

  lostReasons() {
    return this.getDb().collection<LostReasonDoc>('crm_lost_reasons');
  }

  dealStageHistory() {
    return this.getDb().collection<Record<string, unknown>>('crm_deal_stage_history');
  }

  /** Transactional-outbox collection (E3-01, RFC-4 §Р-4). */
  outbox() {
    return this.getDb().collection<OutboxRowDoc>('_outbox');
  }

  /**
   * Consumer idempotency ledger for the drift-detection listener — one row per
   * processed bus messageId (RFC-4 §Р-4 transport dedup). A unique index on
   * `messageId` collapses redeliveries; a TTL reaps rows so it never grows.
   */
  driftInbox() {
    return this.getDb().collection<DriftInboxRowDoc>('crm_drift_inbox');
  }

  /** Mutation idempotency ledger (P2.d) — one row per deduplicated create/merge/import. */
  idempotencyKeys() {
    return this.getDb().collection<IdempotencyRecord>('idempotency_keys');
  }

  /** Async bulk-update jobs (NFR-DEALS-060). */
  bulkJobs() {
    return this.getDb().collection<BulkJobDoc>('crm_bulk_jobs');
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

/** Deterministic Mongo-style compound index name (`{a:1,b:-1}` → `a_1_b_-1`). */
function indexName(key: Record<string, 1 | -1>): string {
  return Object.entries(key)
    .map(([k, v]) => `${k}_${v}`)
    .join('_');
}

/** One processed-message row of the drift-listener idempotency ledger. */
export interface DriftInboxRowDoc {
  _id?: import('mongodb').ObjectId;
  messageId: string;
  routingKey?: string;
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

export interface PipelineStageDoc {
  id: string;
  name: string;
  color: string;
  order: number;
  kind?: string; // active | won | lost
  probability?: number;
  rottingDays?: number;
}

export interface PipelineDoc {
  _id?: import('mongodb').ObjectId;
  projectId: string;
  id: string;
  name: string;
  isDefault?: boolean;
  debounceMs?: number;
  defaultRottingDays?: number;
  stages: PipelineStageDoc[];
  autoTransitions?: { fromStageId: string; toStageId: string }[];
}

export interface LostReasonDoc {
  _id?: import('mongodb').ObjectId;
  projectId: string;
  id: string;
  name: string;
  order: number;
  active: boolean;
}

export interface DealStageLogEntry {
  stageId: string;
  enteredAt: number;
  exitedAt?: number;
  movedBy?: string;
  kind?: string; // move | reopen
}

export interface DealSnapshot {
  name?: string;
  phone?: string;
  email?: string;
  /** Company INN when the snapshot is a company (FR-MDEAL-5 / inn-drift). */
  inn?: string;
  linkedAt?: number;
  linkedBy?: string;
}

export interface DealSourceDoc {
  _id?: import('mongodb').ObjectId;
  projectId: string;
  id: string;
  name: string;
  color: string;
}

export interface BulkJobDoc {
  _id?: import('mongodb').ObjectId;
  projectId: string;
  dealIds: string[];
  change: {
    assigneeId?: string;
    departmentId?: string;
    stageId?: string;
    pipelineId?: string;
  };
  visibilityScope?: import('@fairflow/shared').VisibilityScope;
  userId?: string;
  accessPredicate?: import('@fairflow/shared').AccessPredicate;
  status: 'pending' | 'running' | 'done' | 'failed';
  createdAt: number;
  startedAt?: number;
  finishedAt?: number;
  result?: { updated: string[]; skipped: { id: string; reason: string }[] };
  error?: string;
}

export interface DealDoc {
  _id?: import('mongodb').ObjectId;
  projectId: string;
  pipelineId: string;
  stageId: string;
  name: string;
  amount: number;
  currency: string;
  contactId?: string;
  companyId?: string;
  productId?: string;
  productName?: string;
  assigneeId?: string;
  departmentId?: string;
  source?: string;
  createdAt: number;
  updatedAt: number;
  stageEnteredAt: number;
  // TO-BE lifecycle fields
  status?: string; // open | won | lost
  wonAt?: number;
  lostAt?: number;
  wonVersion?: number;
  lostReasonId?: string;
  lostReasonComment?: string;
  expectedCloseDate?: number;
  probability?: number;
  tags?: string[];
  lightName?: string;
  lightPhone?: string;
  lightEmail?: string;
  lightCompanyName?: string;
  contactSnapshot?: DealSnapshot;
  companySnapshot?: DealSnapshot;
  snapshotHistory?: {
    contactSnapshot?: DealSnapshot;
    companySnapshot?: DealSnapshot;
    at: number;
  }[];
  driftFlag?: boolean;
  driftFields?: string[];
  // Per-field drift detail written by the drift-detection listener (FR-27):
  // field → { snapshotValue, currentValue, changedBy, changedAt }.
  driftDetail?: Record<
    string,
    { snapshotValue?: unknown; currentValue?: unknown; changedBy?: string; changedAt?: number }
  >;
  contactSourceDeleted?: boolean;
  companySourceDeleted?: boolean;
  stageLog?: DealStageLogEntry[];
  deletedAt?: number | null;
  deletedBy?: string;
}
