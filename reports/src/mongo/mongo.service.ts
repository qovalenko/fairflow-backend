import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Collection, Db, MongoClient, ObjectId } from 'mongodb';
import type { EventEnvelope, OutboxStatus } from '@fairflow/shared';

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
   * boot (crash-loop) if Mongo was down at start; this self-heals.
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

  reports(): Collection {
    return this.db.collection('reports_definitions');
  }

  deals(): Collection {
    return this.db.collection('crm_deals');
  }

  orders(): Collection {
    return this.db.collection('crm_orders');
  }

  contacts(): Collection {
    return this.db.collection('contacts');
  }

  companies(): Collection {
    return this.db.collection('companies');
  }

  /** Activity records (overdue/upcoming/recent widgets, FR-MSTAT-12). */
  activities(): Collection {
    return this.db.collection('crm_activities');
  }

  // TODO-026 (box): `org_overview_rollup` / `org_overview_rollup_msgs` accessors
  // are gone with the org-overview contour — the collections had no writer
  // (`OrgRollupStore.applyIncrement` had zero callers) and the cross-project org
  // aggregate is a cloud-only surface. No migration/seed ever created them: they
  // were implicitly materialized by `OrgRollupStore.onModuleInit` index creation,
  // which no longer runs.

  /**
   * Materialized statistics rollup (P2.f · FR-MSTAT-6/19). One row = a running
   * counter of ONE metric in ONE project on ONE UTC day (optionally sliced by
   * low-cardinality dims). NO record ids ever live here — aggregate counters
   * only. `projectId` is the first key of every index (tenant isolation).
   */
  statisticsRollup(): Collection {
    return this.db.collection('statistics_rollup');
  }

  /** Per-(cell,messageId) processed-message guard for idempotent rollup increments (P2.f). */
  statisticsRollupMsgs(): Collection {
    return this.db.collection('statistics_rollup_msgs');
  }

  /** Per-project rollup backfill marker (NFR-010 read-switch coverage). */
  statisticsRollupState(): Collection {
    return this.db.collection('statistics_rollup_state');
  }

  /** Event-sourced deal stage transitions (FR-REPORTS-250). */
  stageTransitions(): Collection {
    return this.db.collection('stage_transitions');
  }

  /** Transactional-outbox collection (E3-01, RFC-4 §Р-4) for report.* emits. */
  outbox(): Collection<OutboxRowDoc> {
    return this.db.collection<OutboxRowDoc>('_outbox');
  }

  getClient(): MongoClient {
    return this.client;
  }

  async healthPing(): Promise<void> {
    await this.db.admin().ping();
  }
}

/** Stored shape of a transactional-outbox row (mirrors `OutboxRow` from shared). */
export interface OutboxRowDoc {
  _id?: ObjectId;
  messageId: string;
  routingKey: string;
  projectId?: string;
  status: OutboxStatus;
  attempts: number;
  envelope: EventEnvelope;
  lastError?: string;
  createdAt: Date;
  updatedAt: Date;
  publishedAt?: Date;
}
