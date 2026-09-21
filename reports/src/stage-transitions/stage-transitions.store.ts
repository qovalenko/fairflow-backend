import { Injectable, OnModuleInit } from '@nestjs/common';
import type { Collection } from 'mongodb';
import { MongoService } from '../mongo/mongo.service';

/** One materialized stage transition (FR-REPORTS-250). */
export interface StageTransitionDoc {
  projectId: string;
  dealId: string;
  pipelineId?: string;
  fromStageId: string;
  toStageId: string;
  enteredAt: number;
  exitedAt?: number;
  movedBy?: string;
  kind?: string;
  /** Idempotency anchor (`idempotencyKey ?? messageId` from the bus fact). */
  messageId: string;
  updatedAt: number;
}

export interface StageTransitionInput {
  projectId: string;
  dealId: string;
  pipelineId?: string;
  fromStageId: string;
  toStageId: string;
  enteredAt: number;
  movedBy?: string;
  kind?: string;
  messageId: string;
}

@Injectable()
export class StageTransitionsStore implements OnModuleInit {
  constructor(private readonly mongo: MongoService) {}

  async onModuleInit(): Promise<void> {
    const col = this.col();
    await col.createIndex(
      { projectId: 1, dealId: 1, messageId: 1 },
      { unique: true, name: 'stage_transitions_idempotent' },
    );
    await col.createIndex(
      { projectId: 1, dealId: 1, enteredAt: -1 },
      { name: 'stage_transitions_deal_timeline' },
    );
    await col.createIndex(
      { projectId: 1, toStageId: 1, enteredAt: 1 },
      { name: 'stage_transitions_metrics' },
    );
  }

  col(): Collection<StageTransitionDoc> {
    return this.mongo.stageTransitions() as unknown as Collection<StageTransitionDoc>;
  }

  /**
   * Idempotent upsert from a `crm.deal.stage_changed` fact. Closes the previous
   * open leg for the deal (sets `exitedAt`) before inserting the new one.
   */
  async applyTransition(input: StageTransitionInput): Promise<void> {
    const now = Date.now();
    const col = this.col();
    const existing = await col.findOne({
      projectId: input.projectId,
      dealId: input.dealId,
      messageId: input.messageId,
    });
    if (existing) return;

    await col.updateMany(
      {
        projectId: input.projectId,
        dealId: input.dealId,
        exitedAt: { $exists: false },
        enteredAt: { $lt: input.enteredAt },
      },
      { $set: { exitedAt: input.enteredAt, updatedAt: now } },
    );

    await col.insertOne({
      projectId: input.projectId,
      dealId: input.dealId,
      pipelineId: input.pipelineId,
      fromStageId: input.fromStageId,
      toStageId: input.toStageId,
      enteredAt: input.enteredAt,
      movedBy: input.movedBy,
      kind: input.kind ?? 'move',
      messageId: input.messageId,
      updatedAt: now,
    });
  }

  async listForDeal(projectId: string, dealId: string): Promise<StageTransitionDoc[]> {
    if (!projectId || !dealId) return [];
    const rows = await this.col()
      .find({ projectId, dealId })
      .sort({ enteredAt: 1, messageId: 1 })
      .toArray();
    return rows as StageTransitionDoc[];
  }

  /**
   * Average dwell time per `toStageId` for transitions whose `enteredAt` falls
   * in `[fromMs, toMs]` (closed legs only — open leg excluded from average).
   */
  async avgDurationByStage(
    projectId: string,
    fromMs: number,
    toMs: number,
  ): Promise<Array<{ stageId: string; count: number; avgDurationMs: number }>> {
    if (!projectId) return [];
    const rows = await this.col()
      .aggregate([
        {
          $match: {
            projectId,
            enteredAt: { $gte: fromMs, $lte: toMs },
            exitedAt: { $exists: true, $type: 'number', $gt: 0 },
          },
        },
        {
          $group: {
            _id: '$toStageId',
            count: { $sum: 1 },
            totalMs: { $sum: { $subtract: ['$exitedAt', '$enteredAt'] } },
          },
        },
        { $sort: { _id: 1 } },
      ])
      .toArray();
    return rows.map((r) => ({
      stageId: String(r._id ?? ''),
      count: Number(r.count ?? 0),
      avgDurationMs: Number(r.count ?? 0) > 0 ? Number(r.totalMs ?? 0) / Number(r.count) : 0,
    }));
  }
}
