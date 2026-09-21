import { Injectable } from '@nestjs/common';
import {
  buildOutboxRow,
  type EmitIntent,
  type OutboxRow,
  type OutboxStore,
} from '@fairflow/shared';
import { MongoService, type OutboxRowDoc } from '../mongo/mongo.service';

/**
 * Mongo-backed transactional outbox store for reports (E3-01 reference impl,
 * RFC-4 §Р-4). reports owns no business store of its own (it is an on-demand
 * composer over the source domains' Mongo views), so its emits are facts about
 * an action that just completed (a report was run / exported). `enqueue` builds
 * the canonical `EventEnvelope` (validating the routing-key against the RFC-4
 * §Р-3 registry — throws on an illegal key) and inserts the pending row; the
 * relay publishes it at-least-once.
 */
@Injectable()
export class MongoOutboxStore implements OutboxStore {
  constructor(private readonly mongo: MongoService) {}

  async enqueue<T>(intent: EmitIntent<T>): Promise<OutboxRow<T>> {
    const row = buildOutboxRow(intent);
    await this.mongo.outbox().insertOne(row as unknown as OutboxRowDoc);
    return row;
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
    await this.mongo
      .outbox()
      .updateOne({ messageId }, { $set: { status: 'published', publishedAt: at, updatedAt: at } });
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
