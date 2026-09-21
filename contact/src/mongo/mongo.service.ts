import { Injectable, Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { Collection, Db, MongoClient } from 'mongodb';
import { abacMaterializedIndexSpecs, type IdempotencyRecord } from '@fairflow/shared';
import { AppConfigService } from '../config/app-config.service';
import { CONTACT_INDEX_SPECS, CONTACT_DEDUP_UNIQUE_INDEXES } from './contact-index-specs';
import { runNormalizedKeyStartup } from '../contacts/normalized-key-startup';

/** Retention for published outbox rows before the TTL monitor purges them (#4): 7 days. */
const OUTBOX_PUBLISHED_TTL_SECONDS = 7 * 24 * 60 * 60;

/** Retention for mutation idempotency ledger rows (P2.d): 24h ≥ retry window. */
const IDEMPOTENCY_TTL_SECONDS = 24 * 60 * 60;

/** NFR-CONTACTS-070: уникальный dedup-индекс не поднялся — это не «Mongo недоступен». */
export class ContactDedupIndexError extends Error {
  readonly indexName: string;
  constructor(indexName: string, causeMessage: string) {
    super(causeMessage);
    this.name = 'ContactDedupIndexError';
    this.indexName = indexName;
  }
}

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
   * Не блокируем Nest bootstrap (gRPC/HTTP). Подключение идёт параллельно;
   * хендлеры ждут через ready() / contacts(). connectPromise — это промис всего
   * retry-цикла (P0-4): он резолвится, когда Mongo наконец поднялся.
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
        await this.ensureAbacIndexes();
        await this.runNormalizedKeyBackfill();
        await this.ensureContactIndexes();
        await this.ensureOutboxIndexes();
        await this.ensureIdempotencyIndexes();
        return;
      } catch (err) {
        await client.close().catch(() => undefined);
        this.client = null;
        this.db = null;
        if (this.destroyed) return;
        // Unique-index collision is a data problem, not a transient outage.
        // Retrying here turned NFR-CONTACTS-070 into a warn-loop (`readyz` hung
        // as `database_not_ready` without a distinct fatal signal).
        if (err instanceof ContactDedupIndexError) {
          this.logger.error(
            { err: err.message, index: err.indexName },
            'contact dedup unique index failed — refusing to become ready',
          );
          throw err;
        }
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
   * Materialized-ABAC indexes (E2-05 / I2b, RFC-5 §1.3). One project-scoped
   * `{ projectId, <attr> }` index per declared materialized attribute so the
   * `compileMongo` ABAC fragment AND-ed by `composeAccessFilter` is index-backed.
   * Idempotent (createIndex is a no-op on an identical spec) and best-effort:
   * a failure here must not block startup of the gRPC/HTTP listeners.
   */
  private async ensureAbacIndexes(): Promise<void> {
    if (!this.db) return;
    const coll = this.db.collection('contacts');
    for (const spec of abacMaterializedIndexSpecs('contacts')) {
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

  /** NFR-CONTACTS-070: idempotent backfill before unique dedup indexes are ensured. */
  private async runNormalizedKeyBackfill(): Promise<void> {
    if (!this.db) return;
    try {
      const report = await runNormalizedKeyStartup(this.db, this.logger);
      if (report.updated > 0 || report.conflicts.length > 0) {
        this.logger.log(
          `normalized-key startup: projects=${report.projects} scanned=${report.scanned} updated=${report.updated} conflicts=${report.conflicts.length}`,
        );
      }
    } catch (err) {
      this.logger.error(
        { err: (err as Error).message },
        'normalized-key startup failed — refusing to become ready',
      );
      throw err;
    }
  }

  /**
   * Contacts collection indexes (#5). Не-уникальные индексы — best-effort.
   * Уникальные dedup-индексы при ошибке бросают `ContactDedupIndexError`:
   * connectWithRetry не ретраит это как обрыв сети, `readyz` остаётся 503.
   *
   * Сами спецификации — в `contact-index-specs.ts`: их же применяет разовая
   * миграция дедуп-ключей, и разъехаться они не должны.
   */
  private async ensureContactIndexes(): Promise<void> {
    if (!this.db) return;
    const coll = this.db.collection('contacts');
    const dedupNames = new Set(CONTACT_DEDUP_UNIQUE_INDEXES.map((s) => String(s.opts.name)));
    for (const spec of CONTACT_INDEX_SPECS) {
      try {
        await coll.createIndex(spec.key, spec.opts);
      } catch (err) {
        const name = String(spec.opts.name);
        const message = (err as Error).message;
        // NFR-CONTACTS-070: сбой уникальных индексов дедупа — видимый отказ
        // готовности, а не warn в логе. Остальные индексы по-прежнему best-effort.
        if (dedupNames.has(name)) {
          this.logger.error({ err: message, index: name }, 'failed to ensure contact dedup index');
          throw new ContactDedupIndexError(name, message);
        }
        this.logger.warn({ err: message, index: name }, 'failed to ensure contact index');
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

  getDb(): Db {
    if (!this.db) throw new Error('MongoDB not connected yet');
    return this.db;
  }

  async contacts(): Promise<Collection<ContactDoc>> {
    await this.ready();
    return this.getDb().collection<ContactDoc>('contacts');
  }

  /** Mutation idempotency ledger (P2.d) — one row per deduplicated create/merge/import. */
  async idempotencyKeys(): Promise<Collection<IdempotencyRecord>> {
    await this.ready();
    return this.getDb().collection<IdempotencyRecord>('idempotency_keys');
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

export interface CompanyLinkPeriod {
  from?: number;
  to?: number;
}

export interface CompanyLink {
  companyId: string;
  role?: string;
  isPrimary?: boolean;
  period?: CompanyLinkPeriod;
  position?: string;
}

export interface ContactDoc {
  _id?: import('mongodb').ObjectId;
  projectId: string;
  firstName: string;
  lastName: string;
  middleName?: string;
  phone: string;
  email: string;
  position?: string;
  companyIds?: string[];
  companyLinks?: CompanyLink[];
  /** FR-CONTACTS-468: денормализация из crm.activity.completed. */
  lastActivityAt?: Date | null;
  /** Компании, удалённые после привязки (FR-MCON-17 / crm.company.deleted). */
  orphanedCompanyIds?: string[];
  source?: string;
  ownerId?: string;
  departmentId?: string;
  tags?: string[];
  notes?: string;
  // Normalized dedup keys (TO-BE, FR-MCON-3). Unset (not '') when value empty.
  phoneNormalized?: string;
  emailNormalized?: string;
  // Merge tombstone (TO-BE, FR-MCON-12/13).
  mergedInto?: import('mongodb').ObjectId | null;
  mergedAt?: Date | null;
  deleteReason?: 'user' | 'merge';
  purgeAt?: Date | null;
  deletedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}
