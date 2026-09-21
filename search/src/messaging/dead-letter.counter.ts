import { Injectable, Logger } from '@nestjs/common';
import type { EventEnvelope } from '@fairflow/shared';
import { MongoService } from '../mongo/mongo.service';

/**
 * Dead-letter accounting for the search consumers (TODO-484).
 *
 * `GET /search/status` reports `dead_letter_count` from
 * `search_index_state.deadLetterCount`, but nothing ever wrote that field: the
 * only producer of dead letters ({@link RabbitMqService.deadLetter}) published to
 * the DLX and ack-ed, so an admin always saw 0 — a projection stuck in the DLQ
 * was invisible in the one place built to surface it.
 *
 * Every terminal drop now lands here: scoped to the project of the event
 * envelope when it can be parsed, and on a process-global counter when it cannot
 * (an unparseable frame has no project — the fact must still not be lost).
 */
@Injectable()
export class DeadLetterCounter {
  private readonly logger = new Logger(DeadLetterCounter.name);
  /** Dead letters that carried no usable projectId (unparseable/scopeless frames). */
  private unscoped = 0;

  constructor(private readonly mongo: MongoService) {}

  /** Dead letters observed in this process that could not be attributed to a project. */
  get unscopedCount(): number {
    return this.unscoped;
  }

  /** Record one terminal dead-letter drop. Best-effort: never throws. */
  async record(content: Buffer | string, reason: string): Promise<void> {
    let projectId = '';
    try {
      const envelope = JSON.parse(String(content)) as EventEnvelope<Record<string, unknown>>;
      projectId = typeof envelope.projectId === 'string' ? envelope.projectId.trim() : '';
    } catch {
      projectId = '';
    }
    if (!projectId) {
      this.unscoped += 1;
      this.logger.error(
        `dead-lettered event without a parseable projectId (unscoped total ${this.unscoped}): ${reason}`,
      );
      return;
    }
    try {
      await this.mongo.searchIndexState().updateOne(
        { projectId },
        {
          $inc: { deadLetterCount: 1 },
          $set: { lastDeadLetterAt: Date.now(), lastDeadLetterReason: reason },
        },
        { upsert: true },
      );
    } catch (e) {
      this.logger.error(`failed to record dead-letter for project ${projectId}: ${String(e)}`);
    }
  }
}
