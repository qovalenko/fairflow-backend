import { Injectable, OnModuleInit } from '@nestjs/common';
import type { Collection } from 'mongodb';
import { MongoService } from '../mongo/mongo.service';

/** Per-project rollup backfill marker (NFR-010 / NFR-MSTAT-8). */
export interface StatisticsRollupStateDoc {
  projectId: string;
  /** Earliest UTC day (`YYYY-MM-DD`) covered by backfill + consumer. */
  backfilledFromDay: string;
  backfilledAt: number;
}

@Injectable()
export class StatisticsRollupCoverageStore implements OnModuleInit {
  constructor(private readonly mongo: MongoService) {}

  async onModuleInit(): Promise<void> {
    await this.col().createIndex({ projectId: 1 }, { unique: true, name: 'stats_rollup_state_project' });
  }

  private col(): Collection<StatisticsRollupStateDoc> {
    return this.mongo.statisticsRollupState() as unknown as Collection<StatisticsRollupStateDoc>;
  }

  async get(projectId: string): Promise<StatisticsRollupStateDoc | null> {
    if (!projectId) return null;
    return (await this.col().findOne({ projectId })) as StatisticsRollupStateDoc | null;
  }

  async markBackfilled(projectId: string, backfilledFromDay: string): Promise<void> {
    if (!projectId || !backfilledFromDay) return;
    const now = Date.now();
    await this.col().updateOne(
      { projectId },
      { $set: { projectId, backfilledFromDay, backfilledAt: now } },
      { upsert: true },
    );
  }

  /**
   * Rollup cells are trusted for `[dayFrom, dayTo]` when the project's backfill
   * marker covers `dayFrom` (inclusive, UTC calendar days).
   */
  isTrusted(state: StatisticsRollupStateDoc | null, dayFrom: string): boolean {
    if (process.env.STATISTICS_ROLLUP_READ_ENABLED === 'false') return false;
    if (!state) return false;
    return state.backfilledFromDay <= dayFrom;
  }
}
