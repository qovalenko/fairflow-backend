import { ObjectId } from 'mongodb';
import { of } from 'rxjs';
import { ReportsService } from './reports.service';
import type { VisibilityScope } from '@fairflow/shared';

/**
 * TODO-253 / FR-REPORTS-090: у каждого встроенного пресета — СВОЙ резолвер.
 *
 * До этой правки `run()` звал один `buildSummary()` на любой отчёт, а
 * `preset_key` ехал только метаданными ответа: шесть вкладок отчётов рисовали
 * одну и ту же таблицу «Стадия / Сделок / Сумма». Здесь фиксируется, что
 * прогон пресета отдаёт его собственный срез, что срез считается тем же
 * `$match` (проект + видимость + фильтры экрана), что и KPI-шапка, и что
 * упавший срез не роняет прогон.
 */

type Rec = Record<string, unknown>;
type Stage = Rec;

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
  selfId: 'u7',
  ownerIds: ['u7'],
  sharedRecordIds: [],
} as VisibilityScope;

/** Ключ группировки агрегации — по нему мок понимает, какой срез спросили. */
const groupKey = (pipeline: Stage[]): string => {
  const group = pipeline.find((st) => st.$group) as { $group?: Rec } | undefined;
  return JSON.stringify(group?.$group?._id ?? null);
};

interface CollOpts {
  count?: number;
  docs?: Rec[];
  agg?: (key: string, pipeline: Stage[]) => Rec[];
  calls?: Rec[];
}

function mockColl(opts: CollOpts = {}) {
  const cursor = (rows: Rec[]): Rec => ({
    sort: () => cursor(rows),
    limit: () => cursor(rows),
    skip: () => cursor(rows),
    project: () => cursor(rows),
    toArray: async () => rows,
  });
  return {
    findOne: async () => null,
    countDocuments: async (f: Rec = {}) => {
      opts.calls?.push(f);
      return opts.count ?? 0;
    },
    aggregate: (pipeline: Stage[]) => {
      opts.calls?.push((pipeline[0] as Rec).$match as Rec);
      const rows = opts.agg ? opts.agg(groupKey(pipeline), pipeline) : [];
      return { toArray: async () => rows };
    },
    find: (f: Rec = {}) => {
      opts.calls?.push(f);
      return cursor(opts.docs ?? []);
    },
  };
}

const REPORT_ID = new ObjectId();

function reportDoc(presetKey: string): Rec {
  return {
    _id: REPORT_ID,
    projectId: 'p1',
    name: `Отчёт ${presetKey}`,
    description: '',
    kind: presetKey,
    presetKey,
    createdAt: 1,
    updatedAt: 1,
    deletedAt: null,
  };
}

function harness(
  presetKey: string,
  colls: { deals?: CollOpts; contacts?: CollOpts; companies?: CollOpts; activities?: CollOpts } = {},
  stages: Rec[] = [
    { id: 's1', name: 'Новая', order: 1 },
    { id: 's2', name: 'В работе', order: 2 },
    { id: 's3', name: 'Выиграна', order: 3 },
  ],
) {
  const docs = [reportDoc(presetKey)];
  const reportsColl = {
    countDocuments: async () => docs.length,
    find: () => ({
      sort: () => ({ skip: () => ({ limit: () => ({ toArray: async () => docs }) }) }),
      project: () => ({ toArray: async () => docs }),
      toArray: async () => docs,
    }),
    findOne: async () => docs[0],
    updateOne: async () => ({}),
    aggregate: () => ({ toArray: async () => [] }),
    bulkWrite: async () => ({}),
    createIndex: async () => 'ix',
  };
  const mongo = {
    reports: () => reportsColl,
    deals: () => mockColl(colls.deals),
    orders: () => mockColl({}),
    contacts: () => mockColl(colls.contacts),
    companies: () => mockColl(colls.companies),
    activities: () => mockColl(colls.activities),
  };
  const svc = new ReportsService(
    mongo as never,
    { enqueue: async () => undefined } as never,
    {
      getService: () => ({
        listPipelines: () => of({ list: [{ id: 'pl1', stages }] }),
      }),
    } as never,
    { getService: () => ({}) } as never,
    { read: async () => [] } as never,
    { get: async () => null, isTrusted: () => false } as never,
    { listForDeal: async () => [], avgDurationByStage: async () => [] } as never,
  );
  svc.onModuleInit();
  return svc;
}

const runData = async (svc: ReportsService, params?: string): Promise<Rec> => {
  const run = await svc.run('p1', REPORT_ID.toString(), params, SCOPE_ALL);
  return JSON.parse(run.data_json) as Rec;
};

describe('TODO-253: пресет sales — динамика и средний чек', () => {
  it('отдаёт sales_dynamics по дням и sales_totals со средним чеком и конверсией', async () => {
    const svc = harness('sales', {
      deals: {
        agg: (key) => {
          if (key.includes('$dateToString')) {
            return [
              { _id: '2026-08-01', count: 2, amount: 200 },
              { _id: null, count: 1, amount: 50 },
            ];
          }
          if (key === '"$status"') {
            return [
              { _id: 'open', count: 1, amount: 100 },
              { _id: 'won', count: 2, amount: 300 },
              { _id: 'lost', count: 1, amount: 100 },
            ];
          }
          return [];
        },
      },
    });
    const data = await runData(svc);
    // Записи без распознаваемой даты в серию не попадают, но в итоги — да.
    expect(data.sales_dynamics).toEqual([{ bucket: '2026-08-01', count: 2, amount: 200 }]);
    expect(data.sales_totals).toMatchObject({
      count: 4,
      amount: 500,
      won_count: 2,
      won_amount: 300,
      lost_count: 1,
      open_count: 1,
      avg_check: 125,
      conversion: 50,
    });
    // чужих срезов у вкладки нет
    expect(data.funnel_stages).toBeUndefined();
    expect(data.deals_by_source).toBeUndefined();
  });
});

describe('TODO-253: пресет funnel — конверсия по стадиям', () => {
  it('стадии идут в порядке воронки, конверсия считается от входной и от предыдущей', async () => {
    const svc = harness('funnel', {
      deals: {
        agg: (key) =>
          key.includes('stageId')
            ? [
                { _id: 's3', count: 5, amount: 500, stalled: 0 },
                { _id: 's1', count: 20, amount: 2000, stalled: 3 },
                { _id: 's2', count: 10, amount: 1000, stalled: 1 },
              ]
            : [],
      },
    });
    const data = await runData(svc);
    const stages = data.funnel_stages as Rec[];
    expect(stages.map((s) => s.stage_id)).toEqual(['s1', 's2', 's3']);
    // подписи — из домена-владельца воронки (pipe), а не сырые id
    expect(stages.map((s) => s.stage_name)).toEqual(['Новая', 'В работе', 'Выиграна']);
    // от входной стадии: 20 → 10 → 5 = 100/50/25 %
    expect(stages.map((s) => s.conversion)).toEqual([100, 50, 25]);
    // от предыдущей: первая стадия — 100 %, дальше 50 % и 50 %
    expect(stages.map((s) => s.conversion_from_prev)).toEqual([100, 50, 50]);
    expect(stages[0].stalled).toBe(3);
    expect(data.stalled_days).toBe(7);
  });

  it('«зависшие» считаются только по открытым сделкам и по реальной дате входа в стадию', async () => {
    // По стадии группируют ДВА среза: общий deals_by_stage сводки и срез
    // пресета — «зависшие» есть только у второго.
    const groups: Rec[] = [];
    const svc = harness('funnel', {
      deals: {
        agg: (_key, pipeline) => {
          const g = (pipeline.find((st) => st.$group) as { $group?: Rec } | undefined)?.$group;
          if (g) groups.push(g);
          return [];
        },
      },
    });
    await runData(svc);
    const group = groups.find((g) => g.stalled) as Rec;
    expect(group).toBeDefined();
    const stalled = JSON.stringify(group.stalled);
    // закрытые сделки исключены по статусу
    expect(stalled).toContain('"won"');
    expect(stalled).toContain('"lost"');
    // запись без дат (0) зависшей не считается
    expect(stalled).toContain('"$gt"');
  });
});

describe('TODO-253: пресет clients — контакты, компании и топ по выручке', () => {
  it('считает новые контакты/компании, контакты без сделок и подписывает компании', async () => {
    const companyId = new ObjectId();
    const contactId = new ObjectId();
    const contactCalls: Rec[] = [];
    const svc = harness('clients', {
      deals: {
        agg: (key) => {
          if (key.includes('companyId')) {
            return [{ _id: companyId.toString(), count: 3, amount: 900 }];
          }
          if (key.includes('contactId')) return [{ _id: contactId.toString() }];
          return [];
        },
      },
      contacts: { count: 12, calls: contactCalls },
      companies: { count: 4, docs: [{ _id: companyId, name: 'ООО «Ромашка»' }] },
    });
    const data = await runData(svc);
    expect(data.clients_totals).toMatchObject({
      contacts_new: 12,
      companies_new: 4,
      contacts_without_deals: 12,
    });
    expect(data.top_companies).toEqual([
      {
        company_id: companyId.toString(),
        company_name: 'ООО «Ромашка»',
        count: 3,
        amount: 900,
      },
    ]);
    // «контакты без сделок» считаются В БД предикатом, а не фильтрацией в памяти
    const withoutDeals = contactCalls.map((f) => JSON.stringify(f)).find((f) => f.includes('$nin'));
    expect(withoutDeals).toContain(contactId.toString());
  });
});

describe('TODO-253: пресет activity — типы, исполнители и просрочки', () => {
  it('отдаёт activity_totals, срез по типам и срез по менеджерам', async () => {
    const svc = harness('activity', {
      activities: {
        agg: (key) => {
          if (key.includes('$type')) {
            return [
              { _id: 'call', count: 5, completed: 2, overdue: 1, open: 3 },
              { _id: 'task', count: 3, completed: 1, overdue: 2, open: 2 },
            ];
          }
          if (key.includes('assigneeId')) {
            return [{ _id: 'u7', count: 8, completed: 3, overdue: 3, open: 5 }];
          }
          return [];
        },
      },
    });
    const data = await runData(svc);
    expect(data.activity_totals).toEqual({ count: 8, completed: 3, overdue: 3, open: 5 });
    expect((data.activities_by_type as Rec[]).map((r) => r.type)).toEqual(['call', 'task']);
    expect(data.activities_by_manager).toEqual([
      { manager_id: 'u7', count: 8, completed: 3, overdue: 3, open: 5 },
    ]);
  });
});

describe('TODO-253: пресет sources — конверсия и средний чек по источнику', () => {
  it('отдаёт deals_by_source с сырым ключом источника', async () => {
    const svc = harness('sources', {
      deals: {
        agg: (key) =>
          key.includes('sourceId')
            ? [
                { _id: 'Сайт', count: 4, amount: 400, won: 1 },
                { _id: '', count: 2, amount: 100, won: 0 },
              ]
            : [],
      },
    });
    const data = await runData(svc);
    expect(data.deals_by_source).toEqual([
      { source: 'Сайт', count: 4, amount: 400, won: 1, conversion: 25, avg_check: 100 },
      { source: '', count: 2, amount: 100, won: 0, conversion: 0, avg_check: 50 },
    ]);
  });
});

describe('TODO-253: срез пресета живёт в тех же границах, что KPI-шапка', () => {
  it('видимость и фильтры экрана уезжают в $match среза пресета', async () => {
    const calls: Rec[] = [];
    const svc = harness('sources', { deals: { calls } });
    await svc.run(
      'p1',
      REPORT_ID.toString(),
      JSON.stringify({ period: 'custom', customFrom: 1_000, customTo: 2_000, pipelineId: 'pl1' }),
      SCOPE_OWN,
    );
    const sourceMatch = calls
      .map((f) => JSON.stringify(f))
      .find((f) => f.includes('sourceId') === false && f.includes('assigneeId'));
    // каждый $match домена начинается с проекта и предиката видимости
    for (const call of calls) {
      const s = JSON.stringify(call);
      expect(s).toContain('"projectId":"p1"');
    }
    expect(sourceMatch).toContain('"$gte":1000');
    expect(sourceMatch).toContain('"pipelineId":"pl1"');
  });

  it('упавший срез пресета не роняет прогон: остаётся сводка и метка preset_partial', async () => {
    const svc = harness('sales', {
      deals: {
        agg: (key) => {
          if (key.includes('$dateToString')) throw new Error('mongo down');
          return [];
        },
      },
    });
    const data = await runData(svc);
    expect(data.preset_partial).toBe(true);
    expect(data.sales_totals).toBeUndefined();
    // общая сводка на месте — экран деградирует, а не падает
    expect(data.totals).toBeDefined();
  });

  it('custom-отчёт без пресета получает прежнюю сводку и никаких срезов', async () => {
    const svc = harness('', { deals: {} });
    const data = await runData(svc);
    expect(data.totals).toBeDefined();
    expect(data.sales_totals).toBeUndefined();
    expect(data.funnel_stages).toBeUndefined();
    expect(data.preset_partial).toBeUndefined();
  });
});

describe('TODO-253: drill разворачивает измерения, которые рисуют срезы', () => {
  it('источник и менеджер разворачиваются в список сделок тем же фильтром', async () => {
    const calls: Rec[] = [];
    const svc = harness('sources', { deals: { calls } });
    await svc.drill('p1', REPORT_ID.toString(), undefined, 'source', 'Сайт', 10, undefined, SCOPE_ALL);
    expect(JSON.stringify(calls)).toContain('"source":"Сайт"');
    const managerCalls: Rec[] = [];
    const svc2 = harness('by_managers', { deals: { calls: managerCalls } });
    await svc2.drill('p1', REPORT_ID.toString(), undefined, 'manager_id', 'u7', 10, undefined, SCOPE_ALL);
    expect(JSON.stringify(managerCalls)).toContain('"assigneeId":"u7"');
  });

  it('TODO-477: пресет activity — drill по типу идёт в crm_activities', async () => {
    const calls: Rec[] = [];
    const svc = harness('activity', { activities: { calls } });
    await svc.drill('p1', REPORT_ID.toString(), undefined, 'type', 'call', 10, undefined, SCOPE_ALL);
    expect(JSON.stringify(calls)).toContain('"type":"call"');
    await svc.drill('p1', REPORT_ID.toString(), undefined, 'manager_id', 'u7', 10, undefined, SCOPE_ALL);
    expect(JSON.stringify(calls)).toContain('"assigneeId":"u7"');
  });

  it('TODO-477: пресет clients — drill по company_id фильтрует сделки компании', async () => {
    const calls: Rec[] = [];
    const svc = harness('clients', { deals: { calls } });
    await svc.drill('p1', REPORT_ID.toString(), undefined, 'company_id', 'c1', 10, undefined, SCOPE_ALL);
    expect(JSON.stringify(calls)).toContain('"companyId":"c1"');
  });

  it('корзина «task» включает активности без типа (зеркало $ifNull)', async () => {
    const calls: Rec[] = [];
    const svc = harness('activity', { activities: { calls } });
    await svc.drill('p1', REPORT_ID.toString(), undefined, 'type', 'task', 10, undefined, SCOPE_ALL);
    // {$in:[null,'task']} — иначе клик по «task» терял документы с отсутствующим type
    expect(JSON.stringify(calls)).toContain('"type":{"$in":[null,"task"]}');
  });

  it('пустое значение — корзина «без значения»: пусты ОБА написания поля', async () => {
    const dealCalls: Rec[] = [];
    const svc = harness('clients', { deals: { calls: dealCalls } });
    await svc.drill('p1', REPORT_ID.toString(), undefined, 'company_id', '', 10, undefined, SCOPE_ALL);
    const q = JSON.stringify(dealCalls);
    // $and (не $or): сделка с companyId=null, но company_id='c5' лежит в корзине
    // «c5», и в «без компании» попадать не должна
    expect(q).toContain('"$and":[{"companyId":{"$in":[null,""]}},{"company_id":{"$in":[null,""]}}]');

    const actCalls: Rec[] = [];
    const svcA = harness('activity', { activities: { calls: actCalls } });
    await svcA.drill('p1', REPORT_ID.toString(), undefined, 'manager_id', '', 10, undefined, SCOPE_ALL);
    expect(JSON.stringify(actCalls)).toContain(
      '"$and":[{"assigneeId":{"$in":[null,""]}},{"ownerId":{"$in":[null,""]}}]',
    );
  });

  it('неизвестное измерение по-прежнему INVALID_ARGUMENT', async () => {
    const svc = harness('sales', { deals: {} });
    await expect(
      svc.drill('p1', REPORT_ID.toString(), undefined, 'bucket', '2026-08-01', 10, undefined, SCOPE_ALL),
    ).rejects.toThrow(/dimension не поддерживается/);
  });
});

describe('TODO-253: экспорт идёт тем же путём данных, что прогон', () => {
  it('CSV пресета «По источникам» содержит его срез, а не только стадии', async () => {
    const svc = harness('sources', {
      deals: {
        agg: (key) =>
          key.includes('sourceId')
            ? [{ _id: 'Сайт', count: 4, amount: 400, won: 1 }]
            : [],
      },
    });
    const res = await svc.export('p1', REPORT_ID.toString(), 'csv', undefined, SCOPE_ALL);
    const csv = Buffer.from(res.payload_base64, 'base64').toString('utf8');
    expect(csv.split('\n')[0]).toBe('section,key,value');
    expect(csv).toContain('deals_by_source,Сайт,4:400:1:25:100');
    // прежние секции на месте — старые парсеры выгрузки не ломаются
    expect(csv).toContain('totals,deals_count,0');
  });
});
