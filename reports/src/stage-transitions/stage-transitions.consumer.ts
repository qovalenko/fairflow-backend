import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { busQueueName, type EventEnvelope } from '@fairflow/shared';
import { ReportsRabbitMqConsumer } from '../messaging/rabbitmq-consumer.service';
import { StageTransitionsStore } from './stage-transitions.store';

export const STAGE_TRANSITIONS_ROUTING_KEYS = ['crm.deal.stage_changed'] as const;

function str(v: unknown): string {
  return typeof v === 'string' ? v : v == null ? '' : String(v);
}

function num(v: unknown): number {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
}

@Injectable()
export class StageTransitionsConsumer implements OnModuleInit {
  private readonly logger = new Logger(StageTransitionsConsumer.name);
  private readonly enabled = process.env.REPORTS_STAGE_TRANSITIONS_ENABLED !== 'false';

  constructor(
    private readonly rabbit: ReportsRabbitMqConsumer,
    private readonly store: StageTransitionsStore,
  ) {}

  async onModuleInit(): Promise<void> {
    if (!this.enabled) {
      this.logger.log('stage-transitions consumer disabled (REPORTS_STAGE_TRANSITIONS_ENABLED=false)');
      return;
    }
    try {
      await this.rabbit.consume(
        busQueueName('reports.stage-transitions'),
        [...STAGE_TRANSITIONS_ROUTING_KEYS],
        (payload, routingKey) => this.handle(payload, routingKey),
      );
      this.logger.log('stage-transitions consumer bound');
    } catch (err) {
      this.logger.error(`stage-transitions consumer failed to bind: ${String(err)}`);
    }
  }

  async handle(payload: Record<string, unknown>, routingKey: string): Promise<void> {
    if (routingKey !== 'crm.deal.stage_changed') return;
    const env = payload as unknown as EventEnvelope<Record<string, unknown>>;
    const projectId = str(env.projectId);
    const messageId = str(env.idempotencyKey) || str(env.messageId);
    if (!projectId || !messageId) {
      throw new Error(`stage_changed without projectId/messageId`);
    }
    const body = (env.payload ?? {}) as Record<string, unknown>;
    const dealId = str(body.dealId);
    if (!dealId) {
      throw new Error(`stage_changed without dealId`);
    }
    const ts = Date.parse(str(env.timestamp));
    const enteredAt = Number.isFinite(ts) ? ts : Date.now();
    await this.store.applyTransition({
      projectId,
      dealId,
      pipelineId: str(body.pipelineId) || undefined,
      fromStageId: str(body.fromStageId),
      toStageId: str(body.toStageId),
      enteredAt,
      movedBy: str(body.movedBy) || undefined,
      kind: str(body.kind) || 'move',
      messageId,
    });
  }
}
