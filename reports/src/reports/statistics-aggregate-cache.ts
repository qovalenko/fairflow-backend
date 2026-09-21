import { createHash } from 'node:crypto';
import type { AccessPredicate } from '@fairflow/shared';
import type { AggregateAccessPredicate } from './access-predicate-bundle';

/**
 * FR-MSTAT-18 / FR-STAT-350: ключ on-demand кэша агрегатов.
 * `(projectId, metric, scopeHash, period)` + для custom окна from/to;
 * enabledModules и ABAC — расширение ключа (без них — утечка между срезами).
 */
export function buildAggregateCacheKey(parts: {
  projectId: string;
  metric: string;
  scopeHash: string;
  period: string;
  periodFrom?: number;
  periodTo?: number;
  modulesKey?: string;
  accessKey?: string;
}): string {
  const periodTail =
    parts.period === 'custom' ? `|${parts.periodFrom ?? 0}|${parts.periodTo ?? 0}` : '';
  const mods = parts.modulesKey ? `|m:${parts.modulesKey}` : '';
  const acc = parts.accessKey ? `|a:${parts.accessKey}` : '';
  return `${parts.projectId}|${parts.metric}|${parts.scopeHash}|${parts.period}${periodTail}${mods}${acc}`;
}

/** Стабильный ключ набора включённых модулей (пусто = набор неизвестен). */
export function modulesCacheKey(enabledModules?: string[]): string {
  if (!enabledModules || enabledModules.length === 0) return '';
  return [...enabledModules].sort().join(',');
}

function normalizePredicate(p?: AccessPredicate): string {
  if (!p) return 'absent';
  if (!p.present) return 'open';
  if (p.malformed) return 'malformed';
  if (!('mongo' in p) || !p.mongo) return 'present-empty';
  return JSON.stringify(p.mongo);
}

/** Детерминированный хеш ABAC-конверта для ключа кэша (без PII). */
export function accessCacheKey(
  access?: AggregateAccessPredicate | AccessPredicate,
): string {
  if (!access) return '0';
  const view = access as AggregateAccessPredicate;
  const parts: string[] = [normalizePredicate(access)];
  if (view.bySubjectMalformed) parts.push('bySubjectMalformed');
  if (view.bySubject) {
    for (const k of Object.keys(view.bySubject).sort()) {
      parts.push(k, normalizePredicate(view.bySubject[k]));
    }
  }
  return createHash('sha256').update(parts.join('|')).digest('hex').slice(0, 16);
}

interface CacheEntry<T> {
  exp: number;
  value: T;
}

/**
 * In-process TTL + LRU кэш агрегатов (NFR-MSTAT-2: дашборд ~60 с).
 * Не Redis: домен reports в BOX не требует внешнего стора для on-demand.
 */
export class StatisticsAggregateCache<T> {
  private readonly store = new Map<string, CacheEntry<T>>();

  constructor(
    private readonly ttlMs: number,
    private readonly maxEntries: number,
  ) {}

  get(key: string): T | undefined {
    const hit = this.store.get(key);
    if (!hit) return undefined;
    if (Date.now() >= hit.exp) {
      this.store.delete(key);
      return undefined;
    }
    // LRU touch
    this.store.delete(key);
    this.store.set(key, hit);
    return hit.value;
  }

  set(key: string, value: T): void {
    this.store.delete(key);
    this.store.set(key, { exp: Date.now() + this.ttlMs, value });
    this.prune();
  }

  private prune(): void {
    const now = Date.now();
    for (const [k, v] of this.store) {
      if (v.exp <= now) this.store.delete(k);
    }
    while (this.store.size > this.maxEntries) {
      const oldest = this.store.keys().next().value;
      if (oldest === undefined) break;
      this.store.delete(oldest);
    }
  }
}

export function dashboardCacheTtlMs(): number {
  const raw = Number(process.env.REPORTS_DASHBOARD_CACHE_TTL_MS ?? 60_000);
  return Number.isFinite(raw) && raw > 0 ? raw : 60_000;
}

export function dashboardCacheMaxEntries(): number {
  const raw = Number(process.env.REPORTS_DASHBOARD_CACHE_MAX ?? 1000);
  return Number.isFinite(raw) && raw > 0 ? raw : 1000;
}

/** Ответ GetDashboard — тот же объект, что уходит в gRPC (не Record, иначе hit widening ломает вызовы). */
export type DashboardKpiCell = {
  key: string;
  label: string;
  value: number;
  previous_value: number;
  growth_rate: number;
};

export type DashboardBreakdownRow = {
  key: string;
  label: string;
  count: number;
  amount: number;
  suppressed?: boolean;
};

export type DashboardActivityRef = {
  id: string;
  title: string;
  due_at: number;
  owner_id: string;
  deep_link: string;
};

export type DashboardStalledRow = {
  id: string;
  name: string;
  amount: number;
  owner_id: string;
  stage_id: string;
  stage_entered_at: number;
};

export type DashboardAggregate = {
  kpi: DashboardKpiCell[];
  funnel: DashboardBreakdownRow[];
  sources: DashboardBreakdownRow[];
  overdue: DashboardActivityRef[];
  upcoming: DashboardActivityRef[];
  recent: DashboardActivityRef[];
  stalled: DashboardStalledRow[];
  overdue_total: number;
  upcoming_total: number;
  recent_total: number;
  stalled_total: number;
  as_of: number;
  partial: boolean;
  scope_level: string;
  period: string;
  from: number;
  to: number;
};
