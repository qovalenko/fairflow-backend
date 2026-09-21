import { Injectable } from '@nestjs/common';
import type { EventEnvelope, OutboxRow, OutboxStore } from '@fairflow/shared';
import { PrismaService } from '../prisma/prisma.service';
import { Prisma } from '../generated/prisma';

/**
 * Postgres-backed transactional outbox store (P8 T5.2, RFC-4 §Р-3/§Р-4).
 *
 * The WRITE path is NOT here — a mutation inserts its outbox row inside its own
 * `$transaction` via {@link insertRow} so the row commits/rolls back atomically
 * with the business + audit write ("no business record without an event"). This
 * store only serves the background relay: read pending rows and flip status.
 */
@Injectable()
export class ControlOutboxStore implements OutboxStore {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Persist one outbox row inside the CALLER's transaction. Must be invoked with
   * the mutation's own `tx` so the event and the business/audit mutation are
   * atomic. `messageId` is the primary key (broker transport dedup) — a retry
   * that re-derives the same row id is an idempotent upsert-noop, never a dup.
   */
  async insertRow(tx: Prisma.TransactionClient, row: OutboxRow): Promise<void> {
    await tx.controlOutbox.create({
      data: {
        messageId: row.messageId,
        routingKey: row.routingKey,
        projectId: row.projectId ?? null,
        status: row.status,
        attempts: row.attempts,
        envelope: row.envelope as unknown as Prisma.InputJsonValue,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
      },
    });
  }

  async fetchPending(limit: number): Promise<OutboxRow[]> {
    const rows = await this.prisma.controlOutbox.findMany({
      where: { status: 'pending' },
      orderBy: { createdAt: 'asc' },
      take: limit,
    });
    return rows.map((r) => ({
      messageId: r.messageId,
      routingKey: r.routingKey,
      projectId: r.projectId ?? undefined,
      status: r.status as OutboxRow['status'],
      attempts: r.attempts,
      envelope: r.envelope as unknown as EventEnvelope,
      lastError: r.lastError ?? undefined,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
      publishedAt: r.publishedAt ?? undefined,
    }));
  }

  async markPublished(messageId: string, at: Date): Promise<void> {
    await this.prisma.controlOutbox.update({
      where: { messageId },
      data: { status: 'published', publishedAt: at, updatedAt: at },
    });
  }

  async markAttemptFailed(
    messageId: string,
    error: string,
    at: Date,
    maxAttempts: number,
  ): Promise<void> {
    const row = await this.prisma.controlOutbox.findUnique({
      where: { messageId },
      select: { attempts: true },
    });
    const attempts = (row?.attempts ?? 0) + 1;
    await this.prisma.controlOutbox.update({
      where: { messageId },
      data: {
        attempts,
        lastError: error.slice(0, 1000),
        status: attempts >= maxAttempts ? 'failed' : 'pending',
        updatedAt: at,
      },
    });
  }
}
