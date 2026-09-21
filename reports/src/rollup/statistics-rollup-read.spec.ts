import {
  canUseRollupRead,
  rollupSalesSeries,
  rollupTrustedForRange,
  sumRollupMetric,
  utcDayOf,
} from './statistics-rollup-read';
import { StatisticsRollupCoverageStore } from './statistics-rollup-coverage';
import type { StatisticsRollupStore } from './statistics-rollup.store';

describe('statistics-rollup-read', () => {
  const coverage = new StatisticsRollupCoverageStore({} as never);

  it('utcDayOf formats UTC calendar day', () => {
    expect(utcDayOf(Date.parse('2026-01-15T12:00:00.000Z'))).toBe('2026-01-15');
  });

  it('canUseRollupRead rejects deals ABAC narrowing (same gate as stage_timing)', () => {
    expect(
      canUseRollupRead(
        { mode: 'all', level: 'all', selfId: 'u1', ownerIds: ['u1'], sharedRecordIds: [] },
        {
          present: true,
          bySubject: {
            deals: { present: true, mongo: { ownerId: 'u1' } },
          },
        } as never,
      ),
    ).toBe(false);
  });

  it('canUseRollupRead allows project-wide scope without deals ABAC', () => {
    expect(
      canUseRollupRead(
        { mode: 'all', level: 'all', selfId: 'u1', ownerIds: ['u1'], sharedRecordIds: [] },
        { present: false },
      ),
    ).toBe(true);
    expect(
      canUseRollupRead(
        { mode: 'restricted', level: 'only_own', selfId: 'u1', ownerIds: ['u1'], sharedRecordIds: [] },
        { present: false },
      ),
    ).toBe(false);
  });

  it('canUseRollupRead отклоняет deferred scope и malformed ABAC', () => {
    expect(
      canUseRollupRead(
        { mode: 'all', level: 'all', selfId: 'u1', ownerIds: ['u1'], sharedRecordIds: [], deferred: true },
        { present: false },
      ),
    ).toBe(false);
    expect(
      canUseRollupRead(
        { mode: 'all', level: 'all', selfId: 'u1', ownerIds: ['u1'], sharedRecordIds: [] },
        { present: true, bySubjectMalformed: true } as never,
      ),
    ).toBe(false);
    expect(
      canUseRollupRead(
        { mode: 'all', level: 'all', selfId: 'u1', ownerIds: ['u1'], sharedRecordIds: [] },
        {
          present: true,
          bySubject: { deals: { present: true, malformed: true } },
        } as never,
      ),
    ).toBe(false);
  });

  it('sumRollupMetric суммирует count и amount по ячейкам', async () => {
    const store = {
      read: jest.fn(async () => [
        { day: '2026-01-01', metric: 'deals_created', value: 2, amount: 100 },
        { day: '2026-01-02', metric: 'deals_created', value: 3, amount: 50 },
      ]),
    } as unknown as StatisticsRollupStore;
    const total = await sumRollupMetric(store, {
      projectId: 'p1',
      metric: 'deals_created',
      dayFrom: '2026-01-01',
      dayTo: '2026-01-02',
    });
    expect(total).toEqual({ count: 5, amount: 150 });
    expect(store.read).toHaveBeenCalledWith({
      projectId: 'p1',
      metrics: ['deals_created'],
      dayFrom: '2026-01-01',
      dayTo: '2026-01-02',
    });
  });

  it('rollupSalesSeries группирует по дню и сортирует bucket', async () => {
    const store = {
      read: jest.fn(async () => [
        { day: '2026-01-02', metric: 'deals_created', value: 1, amount: 10 },
        { day: '2026-01-01', metric: 'deals_created', value: 2, amount: 20 },
        { day: '2026-01-01', metric: 'deals_created', value: 1, amount: 5 },
      ]),
    } as unknown as StatisticsRollupStore;
    const series = await rollupSalesSeries(store, {
      projectId: 'p1',
      dayFrom: '2026-01-01',
      dayTo: '2026-01-02',
    });
    expect(series).toEqual([
      { bucket: '2026-01-01', count: 3, amount: 25 },
      { bucket: '2026-01-02', count: 1, amount: 10 },
    ]);
  });

  it('rollupTrustedForRange respects backfill marker and env flag', () => {
    const prev = process.env.STATISTICS_ROLLUP_READ_ENABLED;
    process.env.STATISTICS_ROLLUP_READ_ENABLED = 'true';
    const state = { projectId: 'p1', backfilledFromDay: '2026-01-01', backfilledAt: 1 };
    expect(
      rollupTrustedForRange(coverage, state, Date.parse('2026-01-10T00:00:00.000Z')),
    ).toBe(true);
    expect(
      rollupTrustedForRange(coverage, state, Date.parse('2025-12-31T00:00:00.000Z')),
    ).toBe(false);
    process.env.STATISTICS_ROLLUP_READ_ENABLED = 'false';
    expect(
      rollupTrustedForRange(coverage, state, Date.parse('2026-01-10T00:00:00.000Z')),
    ).toBe(false);
    if (prev === undefined) delete process.env.STATISTICS_ROLLUP_READ_ENABLED;
    else process.env.STATISTICS_ROLLUP_READ_ENABLED = prev;
  });
});
