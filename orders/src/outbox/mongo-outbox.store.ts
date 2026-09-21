import { Injectable, Logger } from '@nestjs/common';
import type { ClientSession } from 'mongodb';
import {
  buildOutboxRow,
  type EmitIntent,
  type OutboxRow,
  type OutboxStore,
} from '@fairflow/shared';
import { MongoService, type OutboxRowDoc } from '../mongo/mongo.service';

/**
 * Mongo-backed transactional outbox store (E3-01, RFC-4 §Р-4) for orders.
 *
 * `withOutbox` is the write half: it runs the business mutation and inserts the
 * outbox rows it returns in the SAME Mongo session, so the business record and
 * the event row commit or roll back together (invariant Д-1 — "no order without
 * an event, no event without an order"). The relay half reads pending rows from
 * `crm_event_outbox` and flips their status.
 */
@Injectable()
export class MongoOutboxStore implements OutboxStore {
  private readonly logger = new Logger(MongoOutboxStore.name);
  /** Whether the cluster supports multi-doc transactions (replica set / mongos). */
  private txSupported: boolean | null = null;

  constructor(private readonly mongo: MongoService) {}

  /**
   * Run `work` (the business mutation) and insert the outbox rows it returns in
   * ONE transaction, so record + event commit/abort together (invariant Д-1).
   *
   * When the cluster has no transaction support (standalone dev Mongo), it falls
   * back to: run business write, then insert the outbox rows. This narrows but
   * does not eliminate the window (best-effort on standalone) — production runs
   * a replica set where the full transactional guarantee holds.
   *
   * `work` receives the active session (pass it to your `insertOne`/`updateOne`)
   * and returns `{ result, intents }`.
   */
  async withOutbox<R>(
    work: (session: ClientSession | undefined) => Promise<{ result: R; intents: EmitIntent[] }>,
  ): Promise<R> {
    const coll = this.mongo.outbox();

    if (this.txSupported !== false) {
      const session = this.mongo.getClient().startSession();
      try {
        let captured!: { result: R; intents: EmitIntent[] };
        await session.withTransaction(async () => {
          captured = await work(session);
          const rows = captured.intents.map((i) => buildOutboxRow(i) as unknown as OutboxRowDoc);
          if (rows.length) await coll.insertMany(rows, { session });
        });
        this.txSupported = true;
        return captured.result;
      } catch (err) {
        if (this.isNoTxSupport(err)) {
          this.txSupported = false;
          this.logger.warn(
            'MongoDB transactions unavailable (standalone) — outbox falls back to sequential writes',
          );
        } else {
          throw err;
        }
      } finally {
        await session.endSession();
      }
    }

    // Fallback (standalone Mongo): business write, then outbox rows.
    const captured = await work(undefined);
    const rows = captured.intents.map((i) => buildOutboxRow(i) as unknown as OutboxRowDoc);
    if (rows.length) await coll.insertMany(rows);
    return captured.result;
  }

  private isNoTxSupport(err: unknown): boolean {
    const msg = err instanceof Error ? err.message : String(err);
    return (
      msg.includes('Transaction numbers') ||
      msg.includes('replica set') ||
      msg.includes('not supported') ||
      msg.includes('IllegalOperation') ||
      msg.includes('mongos')
    );
  }

  /**
   * Build + insert an outbox row inside `session` (the caller's business tx).
   * Validates the routing-key against the RFC-4 §Р-3 registry (throws → aborts
   * the whole transaction, so nothing is written).
   */
  async enqueue<T>(intent: EmitIntent<T>, session?: ClientSession): Promise<OutboxRow<T>> {
    const row = buildOutboxRow(intent);
    const coll = this.mongo.outbox();
    await coll.insertOne(row as unknown as OutboxRowDoc, session ? { session } : {});
    return row;
  }

  async fetchPending(limit: number): Promise<OutboxRow[]> {
    const coll = this.mongo.outbox();
    const docs = await coll
      .find({ status: 'pending' })
      .sort({ createdAt: 1 })
      .limit(limit)
      .toArray();
    return docs.map((d) => ({
      messageId: d.messageId,
      routingKey: d.routingKey,
      projectId: d.projectId,
      status: d.status,
      attempts: d.attempts,
      envelope: d.envelope as OutboxRow['envelope'],
      lastError: d.lastError,
      createdAt: d.createdAt,
      updatedAt: d.updatedAt,
      publishedAt: d.publishedAt,
    }));
  }

  async markPublished(messageId: string, at: Date): Promise<void> {
    const coll = this.mongo.outbox();
    await coll.updateOne(
      { messageId },
      { $set: { status: 'published', publishedAt: at, updatedAt: at } },
    );
  }

  async markAttemptFailed(
    messageId: string,
    error: string,
    at: Date,
    maxAttempts: number,
  ): Promise<void> {
    const coll = this.mongo.outbox();
    const doc = await coll.findOne({ messageId });
    const attempts = (doc?.attempts ?? 0) + 1;
    await coll.updateOne(
      { messageId },
      {
        $set: {
          attempts,
          lastError: error,
          updatedAt: at,
          status: attempts >= maxAttempts ? 'failed' : 'pending',
        },
      },
    );
  }
}
