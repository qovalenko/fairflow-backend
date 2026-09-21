import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ObjectId } from 'mongodb';
import type { EventEnvelope, VisibilityScope } from '@fairflow/shared';
import { busQueueName } from '@fairflow/shared';
import { MongoService } from '../mongo/mongo.service';
import { RabbitMqConsumer } from '../messaging/rabbitmq.consumer';
import { PipeService } from './pipe.service';
import {
  normalizeAutoTransitions,
  resolveAutoTransitionTarget,
  type StageAutoTransition,
} from './stage-auto-transitions';

export const DEAL_STAGE_CHANGED_KEY = 'crm.deal.stage_changed';

/** Trusted service scope for auto-transition moves (same pattern as orders deal-won). */
const SERVICE_SCOPE: VisibilityScope = {
  mode: 'all',
  level: 'all',
  selfId: '',
  ownerIds: [],
  sharedRecordIds: [],
};

const MAX_CASCADE_DEPTH = Number(process.env.PIPE_AUTO_TRANSITION_MAX_DEPTH ?? 10);

/**
 * FR-DEALS-220 runtime: when a deal enters a stage, apply configured pipeline
 * auto-transitions. Execution lives in pipe (owns pipeline config); user-defined
 * automation rules remain in the automation module.
 */
@Injectable()
export class StageAutoTransitionConsumer implements OnModuleInit {
  private readonly logger = new Logger(StageAutoTransitionConsumer.name);
  private readonly enabled = process.env.PIPE_AUTO_TRANSITION_CONSUMER_ENABLED !== 'false';

  constructor(
    private readonly mongo: MongoService,
    private readonly rabbit: RabbitMqConsumer,
    private readonly pipe: PipeService,
  ) {}

  async onModuleInit(): Promise<void> {
    if (!this.enabled) {
      this.logger.log('stage auto-transition consumer disabled');
      return;
    }
    const queue = busQueueName('pipe.stage-auto-transition');
    try {
      await this.rabbit.consume(
        queue,
        [DEAL_STAGE_CHANGED_KEY],
        (payload, routingKey) => this.handle(payload, routingKey),
        Number(process.env.PIPE_AUTO_TRANSITION_SUBSCRIBE_RETRIES ?? 10),
      );
      this.logger.log(`stage auto-transition consumer bound queue=${queue}`);
    } catch (err) {
      this.logger.error(`stage auto-transition consumer bind failed: ${String(err)}`);
    }
  }

  async handle(payload: Record<string, unknown>, routingKey: string): Promise<void> {
    if (routingKey !== DEAL_STAGE_CHANGED_KEY) return;
    const env = payload as unknown as EventEnvelope<Record<string, unknown>>;
    const projectId = String(env.projectId ?? '');
    const p = (env.payload ?? {}) as Record<string, unknown>;
    const dealId = String(p.dealId ?? env.subject?.split('/').pop() ?? '');
    const toStageId = String(p.toStageId ?? '');
    const depth = Number(p.autoCascadeDepth ?? 0);
    if (!projectId || !dealId || !toStageId) {
      this.logger.warn(`${routingKey} missing projectId/dealId/toStageId — skipped`);
      return;
    }
    if (depth >= MAX_CASCADE_DEPTH) {
      this.logger.warn(
        `auto-transition cascade depth ${depth} exceeded for deal ${dealId} — stopped`,
      );
      return;
    }

    const deal = await this.mongo.deals().findOne({ _id: new ObjectId(dealId), projectId });
    if (!deal || deal.status === 'won' || deal.status === 'lost') return;

    const pl = await this.mongo.pipelines().findOne({
      projectId,
      id: String(deal.pipelineId ?? ''),
    });
    const transitions = normalizeAutoTransitions(
      pl?.autoTransitions as StageAutoTransition[] | undefined,
    );
    const targetStageId = resolveAutoTransitionTarget(transitions, toStageId);
    if (!targetStageId || targetStageId === toStageId) return;

    await this.pipe.moveDealToStage(
      projectId,
      dealId,
      targetStageId,
      SERVICE_SCOPE,
      'auto-transition',
      undefined,
      depth,
    );
  }
}
