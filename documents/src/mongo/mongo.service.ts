import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Collection, Db, MongoClient } from 'mongodb';

/**
 * Mongo collections for the documents domain (TZ §5, snake_case).
 *  - templates           : template pointer (lifecycle draft/published/archived)
 *  - template_revisions  : immutable revisions (S3 file pointer + declared vars)
 *  - document_groups     : context + owner snapshot, drift flag (owner-scoped)
 *  - document_versions   : immutable versions (S3 file pointer + snapshot)
 *
 * AS-IS→TO-BE: legacy flat `documents_templates`/`documents_files` are superseded
 * (migration M-1/M-2 out of scope — OQ-MDOC-5, requires migration window).
 */
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

  private async ensureIndexes() {
    await this.templateRevisions().createIndex(
      { projectId: 1, templateId: 1, version: 1 },
      { unique: true },
    );
    await this.documentGroups().createIndex({ projectId: 1, contextType: 1, contextRecordId: 1 });
    await this.documentGroups().createIndex({ projectId: 1, ownerId: 1 });
    // B2: the read gate ORs ownerId with contextOwnerId (creator OR owner of the
    // documented record) — both branches need an index to stay a push-down.
    await this.documentGroups().createIndex({ projectId: 1, contextOwnerId: 1 });
    await this.documentGroups().createIndex({ projectId: 1, ownerDepartmentId: 1 });
    await this.documentVersions().createIndex(
      { projectId: 1, documentGroupId: 1, version: 1 },
      { unique: true },
    );
    // Unique idempotency for automation generation (FR-MDOC-13 / FR-DOCS-140).
    // NOT sparse: a sparse COMPOUND index still indexes a document when ANY key
    // field is present (missing ones stored as null), so every manual version
    // (no triggerEventId) collided on the null key — the second regenerate /
    // second upload / second chat attachment crashed with E11000 (TODO-044).
    // A partial index over versions that actually carry a triggerEventId is the
    // correct shape. Drop the legacy sparse index first so already-provisioned
    // environments migrate on boot (idempotent across restarts).
    const legacyTriggerIdxName =
      'projectId_1_contextType_1_contextRecordId_1_templateId_1_triggerEventId_1';
    try {
      await this.documentVersions().dropIndex(legacyTriggerIdxName);
      this.logger.log(`Dropped legacy sparse idempotency index ${legacyTriggerIdxName}`);
    } catch (err) {
      const code = (err as { code?: number }).code;
      // 26 NamespaceNotFound (collection not created yet), 27 IndexNotFound —
      // nothing to migrate; anything else is logged below via the create attempt.
      if (code !== 26 && code !== 27) {
        this.logger.warn(
          `Could not drop legacy idempotency index (will still try the partial one): ${(err as Error).message}`,
        );
      }
    }
    try {
      await this.documentVersions().createIndex(
        { projectId: 1, contextType: 1, contextRecordId: 1, templateId: 1, triggerEventId: 1 },
        {
          unique: true,
          name: 'trigger_event_idempotency',
          partialFilterExpression: { triggerEventId: { $exists: true, $type: 'string' } },
        },
      );
    } catch (err) {
      // Possible on stands with pre-existing duplicate triggerEventId rows (or a
      // lingering legacy index). The index is an idempotency aid — generate still
      // checks for an existing triggerEventId version first — so log LOUDLY but
      // do not crash-loop the whole service on boot.
      this.logger.error(
        `Failed to create the trigger_event_idempotency partial index — automation idempotency is degraded to the pre-insert check: ${(err as Error).message}`,
      );
    }
  }

  templates(): Collection {
    return this.db.collection('templates');
  }

  templateRevisions(): Collection {
    return this.db.collection('template_revisions');
  }

  documentGroups(): Collection {
    return this.db.collection('document_groups');
  }

  documentVersions(): Collection {
    return this.db.collection('document_versions');
  }

  /** Transactional-outbox collection (E3-01, RFC-4 §Р-4) — `event_outbox` (§6). */
  outbox(): Collection<OutboxRowDoc> {
    return this.db.collection<OutboxRowDoc>('event_outbox');
  }

  /** Underlying client (for sessions / transactions). */
  getClient(): MongoClient {
    if (!this.client) throw new Error('MongoDB not connected');
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
