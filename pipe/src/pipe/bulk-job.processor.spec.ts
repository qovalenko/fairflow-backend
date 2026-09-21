import { BulkJobProcessorService } from './bulk-job.processor';
import type { MongoService } from '../mongo/mongo.service';
import type { PipeService } from './pipe.service';

describe('BulkJobProcessorService (NFR-DEALS-060)', () => {
  function make(opts?: {
    job?: Record<string, unknown> | null;
    bulkResult?: { updated: string[]; skipped: { id: string; reason: string }[] };
    bulkError?: Error;
  }) {
    const findOneAndUpdate = jest.fn().mockResolvedValue(opts?.job ?? null);
    const updateOne = jest.fn().mockResolvedValue(undefined);
    const bulkJobs = jest.fn().mockReturnValue({ findOneAndUpdate, updateOne });
    const mongo = { bulkJobs } as unknown as MongoService;
    const defaultBulkResult = {
      updated: ['d-1'],
      skipped: [] as { id: string; reason: string }[],
    };
    const bulkUpdateDealsSync = opts?.bulkError
      ? jest.fn().mockRejectedValue(opts.bulkError)
      : jest.fn().mockResolvedValue(opts?.bulkResult ?? defaultBulkResult);
    const pipe = { bulkUpdateDealsSync } as unknown as PipeService;
    const svc = new BulkJobProcessorService(mongo, pipe);
    const drainOnce = (svc as unknown as { drainOnce(): Promise<void> }).drainOnce.bind(svc);
    return { drainOnce, findOneAndUpdate, updateOne, bulkUpdateDealsSync };
  }

  it('does nothing when no pending bulk job exists', async () => {
    const { drainOnce, bulkUpdateDealsSync } = make();
    await drainOnce();
    expect(bulkUpdateDealsSync).not.toHaveBeenCalled();
  });

  it('marks the job done after a successful bulk update', async () => {
    const job = {
      _id: 'job-1',
      projectId: 'p1',
      dealIds: ['d-1', 'd-2'],
      change: { stageId: 'st-won' },
      visibilityScope: { mode: 'all' },
      userId: 'u-1',
    };
    const { drainOnce, bulkUpdateDealsSync, updateOne } = make({
      job,
      bulkResult: {
        updated: ['d-1'],
        skipped: [{ id: 'd-2', reason: 'no_access' }],
      },
    });

    await drainOnce();

    expect(bulkUpdateDealsSync).toHaveBeenCalledWith(
      'p1',
      ['d-1', 'd-2'],
      { stageId: 'st-won' },
      { mode: 'all' },
      'u-1',
      undefined,
    );
    expect(updateOne).toHaveBeenCalledWith(
      { _id: 'job-1' },
      expect.objectContaining({
        $set: expect.objectContaining({
          status: 'done',
          result: {
            updated: ['d-1'],
            skipped: [{ id: 'd-2', reason: 'no_access' }],
          },
        }),
      }),
    );
  });

  it('marks the job failed when bulkUpdateDealsSync throws', async () => {
    const job = {
      _id: 'job-2',
      projectId: 'p1',
      dealIds: ['d-9'],
      change: { assigneeId: 'u-2' },
    };
    const { drainOnce, updateOne } = make({
      job,
      bulkError: new Error('mongo timeout'),
    });

    await drainOnce();

    expect(updateOne).toHaveBeenCalledWith(
      { _id: 'job-2' },
      expect.objectContaining({
        $set: expect.objectContaining({
          status: 'failed',
          error: 'Error: mongo timeout',
        }),
      }),
    );
  });
});
