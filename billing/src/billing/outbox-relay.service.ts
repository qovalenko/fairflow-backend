import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import {
  OutboxRelay,
  type EventEnvelope,
  type OutboxRow,
  type OutboxStore,
} from '@fairflow/shared';
import { PrismaService } from '../prisma/prisma.service';
import { RabbitMqService } from '../messaging/rabbitmq.service';

/**
 * I1a (E3-04): Prisma-backed {@link OutboxStore} over `billing.event_outbox`,
 * driving the shared {@link OutboxRelay} (E3-01). Rows are written in the same
 * tx as the business mutation (ModuleSubscriptionService); this relay pumps
 * `pending` rows to the broker at-least-once and flips them to `published`.
 */
@Injectable()
export class OutboxRelayService implements OutboxStore, OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(OutboxRelayService.name);
  private relay: OutboxRelay | null = null;
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly rabbit: RabbitMqService,
  ) {}

  onModuleInit(): void {
    if (process.env.BILLING_OUTBOX_RELAY_DISABLED === 'true') {
      this.logger.warn('billing outbox relay disabled by env');
      return;
    }
    this.relay = new OutboxRelay(this, {
      publish: (envelope: EventEnvelope) => this.rabbit.publish(envelope),
    });
    const tick = async () => {
      try {
        const result = await this.relay!.tick();
        if (result.published || result.failed) {
          this.logger.debug(`outbox tick published=${result.published} failed=${result.failed}`);
        }
      } catch (err) {
        this.logger.error(`outbox tick error: ${String(err)}`);
      }
    };
    this.timer = setInterval(() => void tick(), this.relay.pollIntervalMs);
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  // ---- OutboxStore ----

  async fetchPending(limit: number): Promise<OutboxRow[]> {
    const rows = await this.prisma.billingEventOutbox.findMany({
      where: { status: 'pending' },
      orderBy: [{ createdAt: 'asc' }, { messageId: 'asc' }],
      take: limit,
    });
    return rows.map((row) => ({
      messageId: row.messageId,
      routingKey: row.routingKey,
      projectId: row.projectId ?? undefined,
      status: row.status as OutboxRow['status'],
      attempts: row.attempts,
      envelope: row.envelope as unknown as EventEnvelope,
      lastError: row.lastError ?? undefined,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      publishedAt: row.publishedAt ?? undefined,
    }));
  }

  async markPublished(messageId: string, at: Date): Promise<void> {
    await this.prisma.billingEventOutbox.update({
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
    const row = await this.prisma.billingEventOutbox.findUnique({
      where: { messageId },
    });
    if (!row) return;
    const attempts = row.attempts + 1;
    await this.prisma.billingEventOutbox.update({
      where: { messageId },
      data: {
        attempts,
        lastError: error,
        status: attempts >= maxAttempts ? 'failed' : 'pending',
        updatedAt: at,
      },
    });
  }
}
