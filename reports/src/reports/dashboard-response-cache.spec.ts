import { ObjectId } from 'mongodb';
import { of } from 'rxjs';
import { ReportsService } from './reports.service';
import type { VisibilityScope } from '@fairflow/shared';
import {
  accessCacheKey,
  buildAggregateCacheKey,
  modulesCacheKey,
  StatisticsAggregateCache,
} from './statistics-aggregate-cache';

type Rec = Record<string, unknown>;

function fakeCollection(opts: { countValue?: number; calls: { count: Rec[] } }) {
  return {
    countDocuments: async (filter: Rec) => {
      opts.calls.count.push(filter);
      return opts.countValue ?? 0;
    },
    aggregate: () => ({ toArray: async () => [] }),
    find: () => ({
      sort: () => ({
        limit: () => ({
          toArray: async () => [],
        }),
      }),
    }),
    findOne: async () => null,
    bulkWrite: async () => ({}),
    createIndex: async () => 'ix',
  };
}

function harness(dealsCount = 0) {
  const dealsCalls = { count: [] as Rec[] };
  const mongo = {
    deals: () => fakeCollection({ countValue: dealsCount, calls: dealsCalls }),
    orders: () => fakeCollection({ countValue: 0, calls: { count: [] } }),
    contacts: () => fakeCollection({ countValue: 0, calls: { count: [] } }),
    companies: () => fakeCollection({ countValue: 0, calls: { count: [] } }),
    activities: () => fakeCollection({ countValue: 0, calls: { count: [] } }),
    reports: () => ({
      countDocuments: async () => 0,
      aggregate: () => ({ toArray: async () => [] }),
      find: () => ({ sort: () => ({ limit: () => ({ toArray: async () => [] }) }) }),
      findOne: async () => ({
        _id: new ObjectId('507f1f77bcf86cd799439011'),
        projectId: 'p1',
        name: 'Продажи',
        kind: 'sales',
        presetKey: 'sales',
        createdAt: 1,
        updatedAt: 1,
      }),
      bulkWrite: async () => ({}),
      createIndex: async () => 'ix',
    }),
  };
  const pipeClient = {
    getService: () => ({
      listPipelines: () =>
        of({ list: [{ id: 'pl1', is_default: true, stages: [] }] }),
    }),
  };
  const contactClient = {
    getService: () => ({
      getContactQualityMetrics: () =>
        of({
          total_contacts: 0,
          filled_both_pct: 0,
          duplicate_candidate_pairs: 0,
          open_drift_links: 0,
        }),
    }),
  };
  const svc = new ReportsService(
    mongo as never,
    { enqueue: async () => undefined } as never,
    pipeClient as never,
    contactClient as never,
    { read: async () => [] } as never,
    { get: async () => null, isTrusted: () => false } as never,
    { listForDeal: async () => [], avgDurationByStage: async () => [] } as never,
  );
  svc.onModuleInit();
  return { svc, dealsCalls };
}

const SCOPE_ALL: VisibilityScope = {
  mode: 'all',
  level: 'all',
  selfId: 'u1',
  ownerIds: [],
  sharedRecordIds: [],
} as VisibilityScope;

const SCOPE_OWN: VisibilityScope = {
  mode: 'restricted',
  level: 'only_own',
  selfId: 'u1',
  ownerIds: ['u1'],
  sharedRecordIds: [],
} as VisibilityScope;

describe('statistics-aggregate-cache key (FR-MSTAT-18 / FR-STAT-350)', () => {
  it('buildAggregateCacheKey: projectId + metric + scopeHash + period', () => {
    const key = buildAggregateCacheKey({
      projectId: 'p1',
      metric: 'dashboard',
      scopeHash: 'abc',
      period: 'month',
    });
    expect(key).toBe('p1|dashboard|abc|month');
  });

  it('custom period включает from/to в ключ', () => {
    const key = buildAggregateCacheKey({
      projectId: 'p1',
      metric: 'dashboard',
      scopeHash: 'abc',
      period: 'custom',
      periodFrom: 1000,
      periodTo: 2000,
    });
    expect(key).toBe('p1|dashboard|abc|custom|1000|2000');
  });

  it('modulesCacheKey сортирует модульный набор', () => {
    expect(modulesCacheKey(['deals', 'orders'])).toBe('deals,orders');
    expect(modulesCacheKey(['orders', 'deals'])).toBe('deals,orders');
  });

  it('accessCacheKey различает ABAC-предикаты', () => {
    const a = accessCacheKey({ present: true, mongo: { region: 'ru' }, ir: null });
    const b = accessCacheKey({ present: true, mongo: { region: 'kz' }, ir: null });
    expect(a).not.toBe(b);
  });
});

describe('StatisticsAggregateCache TTL/LRU', () => {
  it('возвращает значение до истечения TTL', () => {
    const cache = new StatisticsAggregateCache<string>(500, 10);
    cache.set('k', 'v');
    expect(cache.get('k')).toBe('v');
  });

  it('после TTL записи нет', () => {
    const cache = new StatisticsAggregateCache<string>(1, 10);
    cache.set('k', 'v');
    const deadline = Date.now() + 20;
    while (Date.now() < deadline) {
      // spin until TTL expires
    }
    expect(cache.get('k')).toBeUndefined();
  });
});

describe('ReportsService.getDashboard response-cache (FR-STAT-350)', () => {
  it('второй вызов с тем же scope/period обслужен из кэша — Mongo не дергается', async () => {
    const { svc, dealsCalls } = harness();
    await svc.getDashboard('p1', 'month', undefined, undefined, SCOPE_ALL);
    const first = dealsCalls.count.length;
    expect(first).toBeGreaterThan(0);

    await svc.getDashboard('p1', 'month', undefined, undefined, SCOPE_ALL);
    expect(dealsCalls.count.length).toBe(first);
  });

  it('разный scopeHash → отдельные записи кэша', async () => {
    const { svc, dealsCalls } = harness();
    await svc.getDashboard('p1', 'month', undefined, undefined, SCOPE_ALL);
    const afterAll = dealsCalls.count.length;

    await svc.getDashboard('p1', 'month', undefined, undefined, SCOPE_OWN);
    expect(dealsCalls.count.length).toBeGreaterThan(afterAll);
  });

  it('разный ABAC → отдельные записи кэша', async () => {
    const { svc, dealsCalls } = harness();
    const abac1 = { present: true, mongo: { region: 'ru' }, ir: null } as never;
    const abac2 = { present: true, mongo: { region: 'kz' }, ir: null } as never;
    await svc.getDashboard('p1', 'month', undefined, undefined, SCOPE_ALL, undefined, abac1);
    const after1 = dealsCalls.count.length;
    await svc.getDashboard('p1', 'month', undefined, undefined, SCOPE_ALL, undefined, abac2);
    expect(dealsCalls.count.length).toBeGreaterThan(after1);
  });

  it('кэшированный ответ сохраняет as_of момента первого вычисления', async () => {
    const { svc } = harness();
    const first = (await svc.getDashboard('p1', 'month', undefined, undefined, SCOPE_ALL)) as {
      as_of: number;
    };
    const second = (await svc.getDashboard('p1', 'month', undefined, undefined, SCOPE_ALL)) as {
      as_of: number;
    };
    expect(second.as_of).toBe(first.as_of);
  });
});
