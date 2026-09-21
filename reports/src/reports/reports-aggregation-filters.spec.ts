import { ObjectId } from 'mongodb';
import { of, throwError } from 'rxjs';
import { ReportsService } from './reports.service';
import type { VisibilityScope } from '@fairflow/shared';

/**
 * Волна «Статистика» (TODO-112/244/245/246/247/252/254/266/267/495/499/503/504/505).
 *
 * Единый стенд: настоящий ReportsService поверх поддельного MongoService,
 * который ЗАПОМИНАЕТ каждый переданный ему `$match`/pipeline. Проверяем не
 * «что-то вернулось», а ЧТО ИМЕННО уехало в БД — потому что все чинимые дефекты
 * этого модуля жили ровно в фильтрах: удалённые записи не отсекались, ABAC не
 * доезжал, KPI считались без статуса, активности фильтровались по несуществующим
 * полям, а params только возвращались эхом.
 */

type Rec = Record<string, unknown>;

interface CollCalls {
  count: Rec[];
  aggregate: unknown[][];
  find: Rec[];
}

function fakeCollection(opts: {
  countValue?: number;
  aggregateRows?: Rec[];
  findRows?: Rec[];
  calls: CollCalls;
}) {
  const cursor = (rows: Rec[]): Rec => ({
    sort: () => cursor(rows),
    limit: () => cursor(rows),
    skip: () => cursor(rows),
    project: () => cursor(rows),
    toArray: async () => rows,
  });
  return {
    countDocuments: async (filter: Rec) => {
      opts.calls.count.push(filter);
      return opts.countValue ?? 0;
    },
    aggregate: (pipeline: unknown[]) => {
      opts.calls.aggregate.push(pipeline);
      return { toArray: async () => opts.aggregateRows ?? [] };
    },
    find: (filter: Rec = {}) => {
      opts.calls.find.push(filter);
      return cursor(opts.findRows ?? []);
    },
    findOne: async () => null,
    bulkWrite: async () => ({}),
    createIndex: async () => 'ix',
  };
}

interface Harness {
  svc: ReportsService;
  deals: CollCalls;
  orders: CollCalls;
  contacts: CollCalls;
  companies: CollCalls;
  activities: CollCalls;
  pipeCalls: number;
}

function harness(
  opts: {
    dealsCount?: number;
    ordersCount?: number;
    activitiesCount?: number;
    dealRows?: Rec[];
    activityRows?: Rec[];
    dealsAggregate?: Rec[];
    stages?: Array<{ id: string; name: string; order: number }>;
    pipeFails?: boolean;
    reportDoc?: Rec;
  } = {},
): Harness {
  const calls = {
    deals: { count: [], aggregate: [], find: [] } as CollCalls,
    orders: { count: [], aggregate: [], find: [] } as CollCalls,
    contacts: { count: [], aggregate: [], find: [] } as CollCalls,
    companies: { count: [], aggregate: [], find: [] } as CollCalls,
    activities: { count: [], aggregate: [], find: [] } as CollCalls,
    reports: { count: [], aggregate: [], find: [] } as CollCalls,
  };
  const reportDoc = opts.reportDoc ?? {
    _id: new ObjectId('507f1f77bcf86cd799439011'),
    projectId: 'p1',
    name: 'Продажи',
    description: '',
    kind: 'sales',
    presetKey: 'sales',
    createdAt: 1,
    updatedAt: 1,
    deletedAt: null,
  };
  const mongo = {
    deals: () =>
      fakeCollection({
        countValue: opts.dealsCount ?? 0,
        aggregateRows: opts.dealsAggregate ?? [],
        findRows: opts.dealRows ?? [],
        calls: calls.deals,
      }),
    orders: () => fakeCollection({ countValue: opts.ordersCount ?? 0, calls: calls.orders }),
    contacts: () => fakeCollection({ calls: calls.contacts }),
    companies: () => fakeCollection({ calls: calls.companies }),
    activities: () =>
      fakeCollection({
        countValue: opts.activitiesCount ?? 0,
        findRows: opts.activityRows ?? [],
        calls: calls.activities,
      }),
    reports: () => ({
      ...fakeCollection({ calls: calls.reports }),
      findOne: async () => reportDoc,
    }),
  };
  let pipeCalls = 0;
  const pipeClient = {
    getService: () => ({
      listPipelines: () => {
        pipeCalls += 1;
        if (opts.pipeFails) return throwError(() => new Error('pipe down'));
        return of({
          list: [{ id: 'pl1', is_default: true, stages: opts.stages ?? [] }],
        });
      },
    }),
  };
  const svc = new ReportsService(
    mongo as never,
    { enqueue: async () => undefined } as never,
    pipeClient as never,
    { getService: () => ({}) } as never,
      { read: async () => [] } as never,
    { get: async () => null, isTrusted: () => false } as never,
    { listForDeal: async () => [], avgDurationByStage: async () => [] } as never,
  );
  svc.onModuleInit();
  return {
    svc,
    ...calls,
    get pipeCalls() {
      return pipeCalls;
    },
  } as Harness;
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

const json = (v: unknown): string => JSON.stringify(v);

describe('reports: удалённые записи не попадают в агрегаты (TODO-244/267)', () => {
  it('run(): матчи сделок/продаж несут фильтр deletedAt (включая 0 — так пишет orders)', async () => {
    const h = harness();
    await h.svc.run('p1', '507f1f77bcf86cd799439011', undefined, SCOPE_ALL);
    const dealsFilters = [...h.deals.count, ...h.deals.aggregate.map((p) => (p[0] as Rec).$match)];
    expect(dealsFilters.length).toBeGreaterThan(0);
    for (const f of dealsFilters) {
      expect(json(f)).toContain('"deletedAt":{"$in":[null,null,0]}');
    }
    expect(json(h.orders.count[0])).toContain('deletedAt');
  });

  it('getDashboard(): сделки, продажи и активности — все с фильтром живых записей', async () => {
    const h = harness();
    await h.svc.getDashboard('p1', 'month', undefined, undefined, SCOPE_ALL);
    for (const f of [...h.deals.count, ...h.deals.find, ...h.orders.count, ...h.activities.find]) {
      expect(json(f)).toContain('deletedAt');
    }
  });
});

describe('reports: ABAC-предикат доезжает до агрегаций (TODO-112)', () => {
  it('present+mongo → фрагмент уходит в $match (в БД, не в память)', async () => {
    const h = harness();
    await h.svc.getDashboard('p1', 'month', undefined, undefined, SCOPE_ALL, undefined, {
      present: true,
      mongo: { region: 'ru' },
      ir: null,
    } as never);
    expect(json(h.deals.count[0])).toContain('"region":"ru"');
    expect(json(h.activities.find[0])).toContain('"region":"ru"');
  });

  it('malformed → deny-all (сломанное deny-правило не расширяет доступ)', async () => {
    const h = harness();
    await h.svc.run('p1', '507f1f77bcf86cd799439011', undefined, SCOPE_ALL, undefined, true, {
      present: true,
      malformed: true,
    } as never);
    expect(json(h.deals.count[0])).toContain('000000000000000000000000');
  });

  it('отсутствует → никакого дополнительного сужения (не fail-open: projectId и scope остаются)', async () => {
    const h = harness();
    await h.svc.run('p1', '507f1f77bcf86cd799439011', undefined, SCOPE_OWN, undefined, true, {
      present: false,
    } as never);
    const f = json(h.deals.count[0]);
    expect(f).toContain('"projectId":"p1"');
    expect(f).toContain('"assigneeId":{"$in":["u1"]}');
    expect(f).not.toContain('000000000000000000000000');
  });

  it('drill(): предикат и фильтр живых записей применяются и к выборке записей ячейки', async () => {
    const h = harness();
    await h.svc.drill('p1', '507f1f77bcf86cd799439011', undefined, 'stage_id', 's1', 10, undefined, SCOPE_ALL, {
      present: true,
      mongo: { region: 'ru' },
      ir: null,
    } as never);
    expect(json(h.deals.find[0])).toContain('"region":"ru"');
    expect(json(h.deals.find[0])).toContain('deletedAt');
  });
});

describe('reports: KPI дашборда считаются по статусам (TODO-245/254)', () => {
  it('«Сделки в работе» исключают won/lost, «Продажи в работе» — только активные статусы orders', async () => {
    const h = harness();
    await h.svc.getDashboard('p1', 'month', undefined, undefined, SCOPE_ALL);
    expect(json(h.deals.count[0])).toContain('"status":{"$nin":["won","lost"]}');
    expect(json(h.orders.count[0])).toContain('"status":{"$in":["ACTIVE","SENDING","SEND_ERROR"]}');
  });

  it('«Выиграно» считается по дате выигрыша (wonAt), а не по дате создания', async () => {
    const h = harness();
    await h.svc.getDashboard('p1', 'month', undefined, undefined, SCOPE_ALL);
    const wonFilter = h.deals.count.find((f) => json(f).includes('"status":"won"'));
    expect(wonFilter).toBeDefined();
    expect(json(wonFilter)).toContain('wonAt');
    // окно наложено ТОЛЬКО на wonAt: createdAt в этом матче отсутствует
    expect(json(wonFilter)).not.toContain('createdAt');
  });
});

describe('reports: поля активностей совпадают с доменом activity (TODO-246/247/266)', () => {
  it('видимость по assigneeId, сроки по dueDate, терминальные статусы домена', async () => {
    const h = harness({
      activityRows: [{ _id: 'a1', title: 'Звонок', dueDate: 111, assigneeId: 'u7' }],
    });
    const res = await h.svc.getDashboard('p1', 'month', undefined, undefined, SCOPE_OWN);
    const overdue = json(h.activities.find[0]);
    expect(overdue).toContain('"assigneeId":{"$in":["u1"]}');
    expect(overdue).toContain('dueDate');
    expect(overdue).not.toContain('dueAt');
    expect(overdue).toContain('"status":{"$nin":["completed","cancelled"]}');
    // ответ тоже читает dueDate/assigneeId — иначе due_at всегда 0
    expect(res.overdue[0]).toMatchObject({ due_at: 111, owner_id: 'u7' });
  });
});

describe('reports: гейт дашборда по включённым модулям (TODO-461/495)', () => {
  it('модуль orders выключен → продажи не считаются и ячейки KPI нет', async () => {
    const h = harness();
    const res = await h.svc.getDashboard('p1', 'month', undefined, undefined, SCOPE_ALL, [
      'statistics',
      'deals',
      'activities',
    ]);
    expect(h.orders.count).toHaveLength(0);
    expect(res.kpi.map((k) => k.key)).not.toContain('orders_in_progress');
  });

  it('модуль activities выключен → списки активностей не запрашиваются', async () => {
    const h = harness();
    const res = await h.svc.getDashboard('p1', 'month', undefined, undefined, SCOPE_ALL, [
      'statistics',
      'deals',
      'orders',
    ]);
    expect(h.activities.find).toHaveLength(0);
    expect(res.overdue).toEqual([]);
    expect(res.recent).toEqual([]);
  });

  it('набор модулей неизвестен → гейт не применяется (как в getMetrics)', async () => {
    const h = harness();
    const res = await h.svc.getDashboard('p1', 'month', undefined, undefined, SCOPE_ALL, []);
    expect(res.kpi.map((k) => k.key)).toContain('orders_in_progress');
    expect(h.activities.find.length).toBeGreaterThan(0);
  });
});

describe('reports: сравнение с предыдущим периодом (TODO-478/504)', () => {
  it('previous_value/growth_rate считаются по окну той же длины, а не захардкожены нулями', async () => {
    const h = harness({ dealsCount: 4, ordersCount: 4 });
    const res = await h.svc.getDashboard('p1', 'custom', 2_000, 3_000, SCOPE_ALL);
    const cell = res.kpi.find((k) => k.key === 'deals_in_progress');
    expect(cell?.previous_value).toBe(4);
    expect(cell?.growth_rate).toBe(0);
    // окно предыдущего периода — [from-len, from)
    const prev = h.deals.count.find((f) => json(f).includes('"$gte":1000'));
    expect(prev).toBeDefined();
  });
});

describe('reports: порядок стадий воронки берётся у домена pipe (TODO-503)', () => {
  it('стадии выстроены в порядке воронки и подписаны именами', async () => {
    const h = harness({
      stages: [
        { id: 's1', name: 'Новая', order: 1 },
        { id: 's2', name: 'Переговоры', order: 2 },
        { id: 's3', name: 'Счёт', order: 3 },
      ],
      dealsAggregate: [
        { _id: 's3', count: 9, amount: 900 },
        { _id: 's1', count: 5, amount: 500 },
        { _id: 's2', count: 7, amount: 700 },
      ],
    });
    const res = await h.svc.getDashboard('p1', 'month', undefined, undefined, SCOPE_ALL);
    expect(res.funnel.map((f) => f.key)).toEqual(['s1', 's2', 's3']);
    expect(res.funnel.map((f) => f.label)).toEqual(['Новая', 'Переговоры', 'Счёт']);
  });

  it('конверсия в getMetrics считается от ВХОДНОЙ стадии, а не от максимума', async () => {
    const h = harness({
      stages: [
        { id: 's1', name: 'Новая', order: 1 },
        { id: 's2', name: 'Счёт', order: 2 },
      ],
      dealsAggregate: [
        { _id: 's2', count: 8, amount: 800 },
        { _id: 's1', count: 10, amount: 1000 },
      ],
    });
    const res = await h.svc.getMetrics('p1', 'month', undefined, undefined, ['funnel'], SCOPE_ALL);
    expect(res.funnel.map((f) => f.key)).toEqual(['s1', 's2']);
    expect(res.funnel[0].conversion).toBe(1);
    expect(res.funnel[1].conversion).toBeCloseTo(0.8, 5);
  });

  it('pipe недоступен → прежний порядок (по количеству) и partial=true (fail-soft)', async () => {
    const h = harness({
      pipeFails: true,
      dealsAggregate: [
        { _id: 's3', count: 9, amount: 900 },
        { _id: 's1', count: 5, amount: 500 },
      ],
    });
    const res = await h.svc.getDashboard('p1', 'month', undefined, undefined, SCOPE_ALL);
    expect(res.funnel.map((f) => f.key)).toEqual(['s3', 's1']);
    expect(res.partial).toBe(true);
  });
});

describe('reports: срез sales сворачивается в дни на стороне Mongo (TODO-465/505)', () => {
  it('группировка идёт по $dateToString, а не по точной метке createdAt', async () => {
    const h = harness({ dealsAggregate: [{ _id: '2026-08-01', count: 3, amount: 300 }] });
    const res = await h.svc.getMetrics('p1', 'month', undefined, undefined, ['sales'], SCOPE_ALL);
    const pipeline = json(h.deals.aggregate[0]);
    expect(pipeline).toContain('$dateToString');
    expect(pipeline).toContain('"timezone"');
    expect(pipeline).not.toContain('"_id":{"$ifNull":["$createdAt","$created_at"]}');
    expect(res.sales).toEqual([{ bucket: '2026-08-01', count: 3, amount: 300 }]);
  });
});

describe('reports: полные размеры срезов дашборда рядом с усечёнными списками (TODO-498)', () => {
  it('*_total считаются countDocuments ПО ТОМУ ЖЕ матчу, что и усечённый find', async () => {
    const h = harness({
      activitiesCount: 17,
      dealsCount: 4,
      activityRows: [{ _id: 'a1', title: 'Позвонить', dueDate: 1, assigneeId: 'u1' }],
      dealRows: [{ _id: 'd1', name: 'Сделка', amount: 100, assigneeId: 'u1' }],
    });

    const res = await h.svc.getDashboard('p1', 'month', undefined, undefined, SCOPE_ALL);

    // Домен обязан отдать счётчики — без них gateway/виджет считают «+ ещё N»
    // от усечённого списка и получают тождественный ноль.
    expect(res.overdue_total).toBe(17);
    expect(res.upcoming_total).toBe(17);
    expect(res.recent_total).toBe(17);
    expect(res.stalled_total).toBe(4);

    // Три списка активностей + три счётчика: фильтр счётчика совпадает с
    // фильтром своего списка (иначе «+ ещё N» считался бы по чужой выборке).
    expect(h.activities.find).toHaveLength(3);
    expect(h.activities.count).toHaveLength(3);
    for (let i = 0; i < 3; i += 1) {
      expect(json(h.activities.count[i])).toBe(json(h.activities.find[i]));
    }
    // Счётчик «зависших» — по матчу списка зависших (последний find по сделкам).
    expect(json(h.deals.count.at(-1))).toBe(json(h.deals.find.at(-1)));
  });

  it('модуль activities выключен → списки и счётчики нулевые, лишних запросов нет', async () => {
    const h = harness({ activitiesCount: 17 });

    const res = await h.svc.getDashboard('p1', 'month', undefined, undefined, SCOPE_ALL, ['deals']);

    expect(res.overdue).toEqual([]);
    expect(res.overdue_total).toBe(0);
    expect(res.upcoming_total).toBe(0);
    expect(res.recent_total).toBe(0);
    expect(h.activities.count).toHaveLength(0);
    expect(h.activities.find).toHaveLength(0);
  });
});
