/**
 * TODO-154: `reconcileMerge` had no caller at all — losers stayed in
 * `mergeState: 'pending'` forever. These tests pin the sweeper that drives it.
 */
import { MergeReconcileService } from './merge-reconcile.service';
import type { CompaniesService } from './companies.service';

type Pending = { projectId: string; loserId: string };

function buildSweeper(pending: Pending[], failOn: string[] = []) {
  const calls: Pending[] = [];
  const seen: Date[] = [];
  const companies = {
    listPendingMerges: async (mergedBefore: Date, limit: number) => {
      seen.push(mergedBefore);
      return pending.slice(0, limit);
    },
    reconcileMerge: async (projectId: string, loserId: string) => {
      if (failOn.includes(loserId)) throw new Error('mongo down');
      calls.push({ projectId, loserId });
      return { loserId, mergeState: 'settled' };
    },
  } as unknown as CompaniesService;
  return { svc: new MergeReconcileService(companies), calls, cutoffs: seen };
}

const NOW = new Date('2026-08-18T12:00:00.000Z');

describe('MergeReconcileService (TODO-154)', () => {
  it('settles pending merges older than the ack window', async () => {
    const { svc, calls } = buildSweeper([
      { projectId: 'p1', loserId: 'l1' },
      { projectId: 'p2', loserId: 'l2' },
    ]);

    const res = await svc.tick(NOW);

    expect(res).toEqual({ scanned: 2, settled: 2, failed: 0 });
    expect(calls).toEqual([
      { projectId: 'p1', loserId: 'l1' },
      { projectId: 'p2', loserId: 'l2' },
    ]);
  });

  it('asks only for merges older than the ack window (fresh ones keep re-stitching)', async () => {
    const { svc, cutoffs } = buildSweeper([]);
    await svc.tick(NOW);
    expect(cutoffs).toHaveLength(1);
    expect(cutoffs[0].getTime()).toBe(NOW.getTime() - svc.ackWindowMs);
    expect(svc.ackWindowMs).toBeGreaterThan(0);
  });

  it('one failing row does not abort the sweep (it stays pending for the next tick)', async () => {
    const { svc, calls } = buildSweeper(
      [
        { projectId: 'p1', loserId: 'l1' },
        { projectId: 'p1', loserId: 'boom' },
        { projectId: 'p1', loserId: 'l3' },
      ],
      ['boom'],
    );

    const res = await svc.tick(NOW);

    expect(res).toEqual({ scanned: 3, settled: 2, failed: 1 });
    expect(calls.map((c) => c.loserId)).toEqual(['l1', 'l3']);
  });

  it('is idempotent across ticks: nothing left pending → nothing re-run', async () => {
    const pending: Pending[] = [{ projectId: 'p1', loserId: 'l1' }];
    const { svc, calls } = buildSweeper(pending);

    await svc.tick(NOW);
    // The archive row leaves the `pending` query once settled — emulate that.
    pending.length = 0;
    const second = await svc.tick(NOW);

    expect(second).toEqual({ scanned: 0, settled: 0, failed: 0 });
    expect(calls).toHaveLength(1);
  });

  it('never starts the loop when disabled by env', () => {
    const prev = process.env.MERGE_RECONCILE_ENABLED;
    process.env.MERGE_RECONCILE_ENABLED = 'false';
    try {
      const companies = {
        listPendingMerges: jest.fn(),
        reconcileMerge: jest.fn(),
      } as unknown as CompaniesService;
      const svc = new MergeReconcileService(companies);
      svc.onModuleInit();
      svc.onModuleDestroy();
      expect(companies.listPendingMerges).not.toHaveBeenCalled();
    } finally {
      if (prev === undefined) delete process.env.MERGE_RECONCILE_ENABLED;
      else process.env.MERGE_RECONCILE_ENABLED = prev;
    }
  });

  it('respects MERGE_RECONCILE_* env overrides for batch and ack window', async () => {
    const prev = {
      batch: process.env.MERGE_RECONCILE_BATCH,
      ack: process.env.MERGE_RECONCILE_ACK_WINDOW_MS,
    };
    process.env.MERGE_RECONCILE_BATCH = '5';
    process.env.MERGE_RECONCILE_ACK_WINDOW_MS = '120000';
    try {
      const companies = {
        listPendingMerges: jest.fn(async (_cutoff: Date, limit: number) => {
          expect(limit).toBe(5);
          return [];
        }),
        reconcileMerge: jest.fn(),
      } as unknown as CompaniesService;
      const svc = new MergeReconcileService(companies);
      expect(svc.batchSize).toBe(5);
      expect(svc.ackWindowMs).toBe(120_000);
      await svc.tick(NOW);
      expect(companies.listPendingMerges).toHaveBeenCalled();
    } finally {
      if (prev.batch === undefined) delete process.env.MERGE_RECONCILE_BATCH;
      else process.env.MERGE_RECONCILE_BATCH = prev.batch;
      if (prev.ack === undefined) delete process.env.MERGE_RECONCILE_ACK_WINDOW_MS;
      else process.env.MERGE_RECONCILE_ACK_WINDOW_MS = prev.ack;
    }
  });

  it('schedules periodic ticks when enabled on module init', async () => {
    jest.useFakeTimers();
    const prev = process.env.MERGE_RECONCILE_ENABLED;
    process.env.MERGE_RECONCILE_ENABLED = 'true';
    process.env.MERGE_RECONCILE_INTERVAL_MS = '1000';
    try {
      const tick = jest.fn(async () => ({ scanned: 0, settled: 0, failed: 0 }));
      const companies = {
        listPendingMerges: jest.fn(),
        reconcileMerge: jest.fn(),
      } as unknown as CompaniesService;
      const svc = new MergeReconcileService(companies);
      jest.spyOn(svc, 'tick').mockImplementation(tick);
      svc.onModuleInit();
      expect(tick).not.toHaveBeenCalled();
      await jest.advanceTimersByTimeAsync(1000);
      expect(tick).toHaveBeenCalledTimes(1);
      svc.onModuleDestroy();
    } finally {
      jest.useRealTimers();
      if (prev === undefined) delete process.env.MERGE_RECONCILE_ENABLED;
      else process.env.MERGE_RECONCILE_ENABLED = prev;
      delete process.env.MERGE_RECONCILE_INTERVAL_MS;
    }
  });

  it('does not overlap ticks while a sweep is still running', async () => {
    let release!: () => void;
    const companies = {
      listPendingMerges: jest.fn(),
      reconcileMerge: jest.fn(),
    } as unknown as CompaniesService;
    const svc = new MergeReconcileService(companies);
    jest.spyOn(svc, 'tick').mockImplementation(
      () =>
        new Promise((resolve) => {
          release = () => resolve({ scanned: 0, settled: 0, failed: 0 });
        }),
    );
    const runner = svc as unknown as { runOnce(): Promise<void> };
    const first = runner.runOnce();
    void runner.runOnce();
    await Promise.resolve();
    expect(svc.tick).toHaveBeenCalledTimes(1);
    release();
    await first;
  });
});
