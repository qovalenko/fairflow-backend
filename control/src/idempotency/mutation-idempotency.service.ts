import { Injectable } from '@nestjs/common';
import {
  PLATFORM_CONSTANTS,
  withIdempotency,
  type IdempotencyCollection,
  type IdempotencyRecord,
} from '@fairflow/shared';

/**
 * In-process mutation dedup for control (Postgres) mutations that do not have a
 * per-domain Mongo `idempotency_keys` ledger. Scoped by `{projectId, operation, key}`
 * with TTL from {@link PLATFORM_CONSTANTS.IDEMPOTENCY_DEDUP_TTL_MS}. Box v1 runs
 * control as a single replica; a durable Postgres ledger is a follow-up for HA.
 */
class InMemoryIdempotencyCollection implements IdempotencyCollection {
  private rows: IdempotencyRecord[] = [];
  private readonly ttlMs = PLATFORM_CONSTANTS.IDEMPOTENCY_DEDUP_TTL_MS;

  private purgeExpired(): void {
    const cutoff = Date.now() - this.ttlMs;
    this.rows = this.rows.filter((r) => r.createdAt.getTime() > cutoff);
  }

  private index(projectId: string, key: string): number {
    this.purgeExpired();
    return this.rows.findIndex((r) => r.projectId === projectId && r.key === key);
  }

  async insertOne(doc: IdempotencyRecord): Promise<unknown> {
    if (this.index(doc.projectId, doc.key) >= 0) {
      throw Object.assign(new Error('E11000 duplicate key'), { code: 11000 });
    }
    this.rows.push({ ...doc });
    return {};
  }

  async findOne(filter: { projectId: string; key: string }): Promise<IdempotencyRecord | null> {
    const i = this.index(filter.projectId, filter.key);
    return i >= 0 ? { ...this.rows[i] } : null;
  }

  async updateOne(
    filter: { projectId: string; key: string },
    update: { $set: Partial<IdempotencyRecord> },
  ): Promise<unknown> {
    const i = this.index(filter.projectId, filter.key);
    if (i >= 0) this.rows[i] = { ...this.rows[i], ...update.$set };
    return { matchedCount: i >= 0 ? 1 : 0 };
  }

  async deleteOne(filter: { projectId: string; key: string }): Promise<unknown> {
    const i = this.index(filter.projectId, filter.key);
    if (i >= 0) this.rows.splice(i, 1);
    return { deletedCount: i >= 0 ? 1 : 0 };
  }
}

@Injectable()
export class MutationIdempotencyService {
  private readonly collection = new InMemoryIdempotencyCollection();

  async run<T>(
    params: { projectId: string; key: string | undefined; operation: string },
    executor: () => Promise<T>,
  ): Promise<T> {
    return withIdempotency(
      this.collection,
      {
        projectId: params.projectId,
        key: params.key,
        operation: params.operation,
      },
      executor,
    );
  }
}
