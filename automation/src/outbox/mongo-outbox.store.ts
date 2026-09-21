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
 * Transactional outbox for automation rule mutations (FR-AUTOM-410).
 */
@Injectable()
export class AutomationMongoOutboxStore implements OutboxStore {
  private readonly logger = new Logger(AutomationMongoOutboxStore.name);
  private txSupported: boolean | null = null;

  constructor(private readonly mongo: MongoService) {}

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
            'MongoDB transactions unavailable (standalone) — automation outbox falls back to sequential writes',
          );
        } else {
          throw err;
        }
      } finally {
        await session.endSession();
      }
    }

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

  async fetchPending(limit: number): Promise<OutboxRow[]> {
    const docs = await this.mongo
      .outbox()
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
    await this.mongo.outbox().updateOne(
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
    const doc = await this.mongo.outbox().findOne({ messageId });
    const attempts = (doc?.attempts ?? 0) + 1;
    await this.mongo.outbox().updateOne(
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
