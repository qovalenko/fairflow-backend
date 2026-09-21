import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { MongoService, type BulkJobDoc } from '../mongo/mongo.service';
import { PipeService } from './pipe.service';

/**
 * NFR-DEALS-060: processes bulk deal updates exceeding the synchronous limit (200).
 */
@Injectable()
export class BulkJobProcessorService implements OnModuleInit {
  private readonly logger = new Logger(BulkJobProcessorService.name);
  private running = false;

  constructor(
    private readonly mongo: MongoService,
    private readonly pipe: PipeService,
  ) {}

  onModuleInit(): void {
    const tick = () => {
      if (!this.running) {
        this.running = true;
        this.drainOnce()
          .catch((err) => this.logger.error(`bulk job drain failed: ${String(err)}`))
          .finally(() => {
            this.running = false;
          });
      }
    };
    setInterval(tick, Number(process.env.PIPE_BULK_JOB_POLL_MS ?? 2000));
  }

  private async drainOnce(): Promise<void> {
    const job = await this.mongo
      .bulkJobs()
      .findOneAndUpdate(
        { status: 'pending' },
        { $set: { status: 'running', startedAt: Date.now() } },
        { sort: { createdAt: 1 }, returnDocument: 'after' },
      );
    if (!job) return;
    const doc = job as BulkJobDoc;
    try {
      const result = await this.pipe.bulkUpdateDealsSync(
        doc.projectId,
        doc.dealIds,
        doc.change,
        doc.visibilityScope,
        doc.userId,
        doc.accessPredicate,
      );
      await this.mongo.bulkJobs().updateOne(
        { _id: doc._id },
        {
          $set: {
            status: 'done',
            finishedAt: Date.now(),
            result: {
              updated: result.updated,
              skipped: result.skipped,
            },
          },
        },
      );
      this.logger.log(
        `bulk job ${String(doc._id)} done: updated=${result.updated.length} skipped=${result.skipped.length}`,
      );
    } catch (err) {
      await this.mongo
        .bulkJobs()
        .updateOne(
          { _id: doc._id },
          { $set: { status: 'failed', finishedAt: Date.now(), error: String(err) } },
        );
      this.logger.error(`bulk job ${String(doc._id)} failed: ${String(err)}`);
    }
  }
}
