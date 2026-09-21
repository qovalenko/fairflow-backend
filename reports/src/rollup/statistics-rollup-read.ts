import type { AccessPredicate, VisibilityScope } from '@fairflow/shared';
import type { AggregateAccessPredicate } from '../reports/access-predicate-bundle';
import type { StatisticsRollupStore } from './statistics-rollup.store';
import type { StatisticsRollupCoverageStore } from './statistics-rollup-coverage';

/** Epoch ms → UTC `YYYY-MM-DD`. */
export function utcDayOf(ts: number): string {
  return new Date(ts).toISOString().slice(0, 10);
}

/**
 * Rollup read-path is project-wide event counts — safe only when the viewer sees
 * the whole project (mode `all`) and ABAC does not narrow the deals source.
 */
export function canUseRollupRead(
  scope: VisibilityScope,
  access?: AggregateAccessPredicate | AccessPredicate,
): boolean {
  if (scope.mode !== 'all' || scope.deferred) return false;
  const agg = access as AggregateAccessPredicate | undefined;
  const dealsPred = agg?.bySubject?.deals;
  if (agg?.bySubjectMalformed) return false;
  if (dealsPred?.present) {
    if (dealsPred.malformed) return false;
    if ('mongo' in dealsPred && dealsPred.mongo && Object.keys(dealsPred.mongo).length > 0) {
      return false;
    }
  }
  return true;
}

export interface RollupSeriesRow {
  bucket: string;
  count: number;
  amount: number;
}

export async function sumRollupMetric(
  store: StatisticsRollupStore,
  params: {
    projectId: string;
    metric: string;
    dayFrom: string;
    dayTo: string;
  },
): Promise<{ count: number; amount: number }> {
  const rows = await store.read({
    projectId: params.projectId,
    metrics: [params.metric],
    dayFrom: params.dayFrom,
    dayTo: params.dayTo,
  });
  let count = 0;
  let amount = 0;
  for (const r of rows) {
    count += r.value;
    amount += r.amount;
  }
  return { count, amount };
}

export async function rollupSalesSeries(
  store: StatisticsRollupStore,
  params: { projectId: string; dayFrom: string; dayTo: string },
): Promise<RollupSeriesRow[]> {
  const rows = await store.read({
    projectId: params.projectId,
    metrics: ['deals_created'],
    dayFrom: params.dayFrom,
    dayTo: params.dayTo,
  });
  const byDay = new Map<string, RollupSeriesRow>();
  for (const r of rows) {
    const cur = byDay.get(r.day) ?? { bucket: r.day, count: 0, amount: 0 };
    cur.count += r.value;
    cur.amount += r.amount;
    byDay.set(r.day, cur);
  }
  return [...byDay.values()].sort((a, b) => a.bucket.localeCompare(b.bucket));
}

export function rollupTrustedForRange(
  coverage: StatisticsRollupCoverageStore,
  state: Awaited<ReturnType<StatisticsRollupCoverageStore['get']>>,
  fromMs: number,
): boolean {
  return coverage.isTrusted(state, utcDayOf(fromMs));
}
