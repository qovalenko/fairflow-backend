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
  private connectPromise: Promise<void> | null = null;
  // Retry-loop control (P0-4): flag + timer/resolver so onModuleDestroy can stop
  // the backoff loop cleanly without leaving a dangling timer (jest/graceful shutdown).
  private destroyed = false;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private retryResolve: (() => void) | null = null;

  constructor(private readonly config: AppConfigService) {}

  /**
   * Не блокируем Nest bootstrap. connectPromise — это промис всего retry-цикла
   * (P0-4): он резолвится, когда Mongo наконец поднялся; хендлеры ждут ready().
   */
  onModuleInit(): void {
    this.connectPromise = this.connectWithRetry();
    void this.connectPromise.catch(() => undefined);
  }

  /**
   * Connect to MongoDB with exponential backoff (1s → 2s → 4s … cap 30s), retrying
   * forever until success or onModuleDestroy (P0-4). A one-shot connect left the
   * pod permanently NotReady if Mongo was down at boot; this self-heals. Index
   * setup failures also trigger a retry of the whole cycle.
   */
  private async connectWithRetry(): Promise<void> {
    const url = this.config.databaseUrl;
    let attempt = 0;
    let delayMs = 1_000;
    while (!this.destroyed) {
      attempt += 1;
      const client = new MongoClient(url, {
        serverSelectionTimeoutMS: 10_000,
        connectTimeoutMS: 10_000,
        socketTimeoutMS: 45_000,
      });
      try {
        await client.connect();
        if (this.destroyed) {
          await client.close().catch(() => undefined);
          return;
        }
        this.client = client;
        this.db = client.db();
        this.logger.log('MongoDB connected');
        await this.ensureCompanyIndexes();
        await this.ensureOutboxIndexes();
        await this.ensureIdempotencyIndexes();
        await this.ensureMergeArchiveIndexes();
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
      this.connectPromise = null;
    }
  }

  async ready(): Promise<void> {
    if (!this.connectPromise) throw new Error('MongoDB not started');
    await this.connectPromise;
  }

  /**
   * Companies collection indexes (#5). Best-effort/idempotent — a failure here
   * must not block startup of the gRPC/HTTP listeners.
   *
   * - `{ projectId, deletedAt, updatedAt, _id }` backs the default project-scoped
   *   `list` (filter projectId+deletedAt, sort updatedAt desc). The trailing `_id`
   *   mirrors the tie-breaker `list()` adds to its sort so skip/limit paging is a
   *   total order; without it in the index the planner would fall back to a blocking
   *   in-memory SORT. Directions (`updatedAt: -1, _id: -1`) serve both `sortDir`
   *   values — desc matches the index, asc matches its exact inverse. It supersedes
   *   the older `project_deleted_updated` (a strict prefix), which is dropped below
   *   once the wider index exists.
   * - `{ projectId, deletedAt, ownerId|status|industry }` back the
   *   owner/status/industry list filters.
   * - Partial-unique `{ projectId, identityHash }` hard-enforces per-project
   *   identity dedup, replacing the racy check-then-insert in `create`. Partial
   *   on `identityHash: { $exists: true }` only — Mongo rejects `deletedAt: null`
   *   in a partialFilterExpression ("Expression not supported in partial index").
   *   Soft-delete/merge $unset `identityHash`, so tombstoned rows drop out of the
   *   index and re-creating the same identity is not blocked while live rows stay
   *   unique.
   */
  private async ensureCompanyIndexes(): Promise<void> {
    if (!this.db) return;
    const coll = this.db.collection('companies');
    const specs: { key: Record<string, 1 | -1>; opts: Record<string, unknown> }[] = [
      {
        key: { projectId: 1, deletedAt: 1, updatedAt: -1, _id: -1 },
        opts: { name: 'project_deleted_updated_id' },
      },
      {
        key: { projectId: 1, deletedAt: 1, ownerId: 1 },
        opts: { name: 'project_deleted_owner' },
      },
      {
        key: { projectId: 1, deletedAt: 1, status: 1 },
        opts: { name: 'project_deleted_status' },
      },
      {
        key: { projectId: 1, deletedAt: 1, industry: 1 },
        opts: { name: 'project_deleted_industry' },
      },
      {
        key: { projectId: 1, identityHash: 1 },
        opts: {
          name: 'uniq_project_identity',
          unique: true,
          partialFilterExpression: { identityHash: { $exists: true } },
        },
      },
      // FR-COMPANIES-040: purgeAt задаётся при soft-delete; TTL с expireAfterSeconds:0
      // физически удаляет документ по наступлении срока. restore делает $unset purgeAt.
      {
        key: { purgeAt: 1 },
        opts: { name: 'ttl_purge_at', expireAfterSeconds: 0 },
      },
    ];
    let listIndexOk = false;
    for (const spec of specs) {
      try {
        await coll.createIndex(spec.key, spec.opts);
        if (spec.opts.name === 'project_deleted_updated_id') listIndexOk = true;
      } catch (err) {
        this.logger.warn(
          { err: (err as Error).message, index: spec.opts.name },
          'failed to ensure company index',
        );
      }
    }
    // Drop the superseded list index ONLY after its replacement is in place — otherwise a
    // failed createIndex would leave `list` with no index at all. A missing index is the
    // normal case (fresh DB / already dropped), so the failure is swallowed, not logged.
    if (listIndexOk) {
      try {
        await coll.dropIndex('project_deleted_updated');
      } catch {
        /* index absent (fresh install or already dropped) — nothing to do */
      }
    }
  }

  /**
   * Outbox indexes (#4): `{ status, createdAt }` backs the relay's
   * `fetchPending` (find status=pending sort createdAt), plus a partial TTL on
   * `publishedAt` to auto-purge published rows after a retention window.
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

  /**
   * Mutation idempotency ledger indexes (P2.d): a unique `{ projectId, key }` so a
   * retried create/merge/import claims the same row, plus a 24h TTL on `createdAt`
   * to reap stale keys. Idempotent and best-effort — must not block startup.
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

  /**
   * Merge shadow-copy indexes: `{ projectId, originalId }` backs the merge idempotency
   * lookup and the revert, `{ mergeState, mergedAt }` backs the pending→settled sweep
   * (TODO-154) so the minute-tick does not scan the collection.
   */
  private async ensureMergeArchiveIndexes(): Promise<void> {
    if (!this.db) return;
    const coll = this.db.collection('company_archives');
    const specs: { key: Record<string, 1 | -1>; opts: Record<string, unknown> }[] = [
      { key: { projectId: 1, originalId: 1 }, opts: { name: 'project_original' } },
      { key: { mergeState: 1, mergedAt: 1 }, opts: { name: 'mergestate_mergedat' } },
      // FR-COMPANIES-160: физическая очистка merge-shadow по expiresAt.
      { key: { expiresAt: 1 }, opts: { name: 'ttl_expires_at', expireAfterSeconds: 0 } },
    ];
    for (const spec of specs) {
      try {
        await coll.createIndex(spec.key, spec.opts);
      } catch (err) {
        this.logger.warn(
          { err: (err as Error).message, index: spec.opts.name },
          'failed to ensure merge archive index',
        );
      }
    }
  }

  getDb(): Db {
    if (!this.db) throw new Error('MongoDB not connected yet');
    return this.db;
  }

  async companies(): Promise<Collection<CompanyDoc>> {
    await this.ready();
    return this.getDb().collection<CompanyDoc>('companies');
  }

  /** Mutation idempotency ledger (P2.d) — one row per deduplicated create/merge/import. */
  async idempotencyKeys(): Promise<Collection<IdempotencyRecord>> {
    await this.ready();
    return this.getDb().collection<IdempotencyRecord>('idempotency_keys');
  }

  /** Shadow copies of merged companies for time-boxed revert (company.md §5.3). */
  async companyArchives(): Promise<Collection<CompanyArchiveDoc>> {
    await this.ready();
    return this.getDb().collection<CompanyArchiveDoc>('company_archives');
  }

  /** Transactional-outbox collection (E3-01, RFC-4 §Р-4). */
  async outbox(): Promise<Collection<OutboxRowDoc>> {
    await this.ready();
    return this.getDb().collection<OutboxRowDoc>('_outbox');
  }

  /** Underlying client (for sessions / transactions). */
  getClient(): MongoClient {
    if (!this.client) throw new Error('MongoDB not connected yet');
    return this.client;
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

export interface CompanyDoc {
  _id?: import('mongodb').ObjectId;
  projectId: string;
  name: string;
  inn?: string;
  kpp?: string;
  legalAddress?: string;
  phone?: string;
  email?: string;
  industry?: string;
  ownerId?: string;
  tags?: string[];
  notes?: string;
  // TO-BE fields (company.md §1).
  ogrn?: string;
  website?: string;
  domain?: string;
  status?: string; // lead|client|partner|former, default lead
  departmentId?: string;
  region?: string;
  source?: string; // manual|import|api|drawer
  identityHash?: string; // service field, never exposed outward
  mergeState?: string | null; // pending|settled on loser
  createdBy?: string;
  updatedBy?: string;
  bankName?: string;
  bik?: string;
  correspondentAccount?: string;
  settlementAccount?: string;
  /** Monotonic revision for contact-linked card sections (FR-COMPANIES-220). */
  cardContactsRev?: number;
  /** Auto-purge anchor for trash / merge tombstone (FR-COMPANIES-040). */
  purgeAt?: Date | null;
  deletedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface CompanyArchiveDoc {
  _id?: import('mongodb').ObjectId;
  projectId: string;
  originalId: string; // loser id
  masterId: string;
  snapshotDoc: CompanyDoc;
  mergeState: string; // pending|settled
  mergedBy?: string;
  mergedAt: Date;
  expiresAt: Date; // TTL anchor for revert window
}
