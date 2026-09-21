import { ObjectId } from 'mongodb';
import { of } from 'rxjs';
import { ReportsService } from './reports.service';
import type { VisibilityScope } from '@fairflow/shared';

/**
 * Волна «Статистика», вторая половина (TODO-248/249/251/252/471/501/502).
 *
 * Здесь фиксируется путь «определение отчёта → прогон»: встроенный пресет должен
 * опознаваться как встроенный (и не удаляться), его ключ — доезжать до фронта
 * вместо эвристики по индексу, фильтры экрана — реально сужать выборку, а
 * границы периода и подписи дневных бакетов — считаться в ОДНОЙ таймзоне.
 */

type Rec = Record<string, unknown>;

const SCOPE_ALL: VisibilityScope = {
  mode: 'all',
  level: 'all',
  selfId: 'u1',
  ownerIds: [],
  sharedRecordIds: [],
} as VisibilityScope;

const json = (v: unknown): string => JSON.stringify(v);

function reportsStore(docs: Rec[]) {
  const bulk: unknown[][] = [];
  const cursor = (rows: Rec[]): Rec => ({
    sort: () => cursor(rows),
    limit: () => cursor(rows),
    skip: () => cursor(rows),
    project: () => cursor(rows),
    toArray: async () => rows,
  });
  const coll = {
    countDocuments: async () => docs.length,
    find: () => cursor(docs),
    findOne: async (filter: Rec) =>
      docs.find((d) => String(d._id) === String((filter as { _id?: unknown })._id)) ?? docs[0] ?? null,
    insertOne: async (doc: Rec) => {
      docs.push(doc);
      return {};
    },
    updateOne: async () => ({}),
    aggregate: () => ({ toArray: async () => [] }),
    bulkWrite: async (ops: unknown[]) => {
      bulk.push(ops);
      return {};
    },
    createIndex: async () => 'ix',
  };
  return { coll, bulk, docs };
}

function svcWith(store: ReturnType<typeof reportsStore>, dealsCalls: Rec[] = []) {
  const empty = (calls: Rec[]) => {
    const cursor = (): Rec => ({
      sort: () => cursor(),
      limit: () => cursor(),
      skip: () => cursor(),
      project: () => cursor(),
      toArray: async () => [],
    });
    return {
      countDocuments: async (f: Rec) => {
        calls.push(f);
        return 0;
      },
      aggregate: (p: unknown[]) => {
        calls.push((p[0] as Rec).$match as Rec);
        return { toArray: async () => [] };
      },
      find: (f: Rec = {}) => {
        calls.push(f);
        return cursor();
      },
    };
  };
  const mongo = {
    reports: () => store.coll,
    deals: () => empty(dealsCalls),
    orders: () => empty([]),
    contacts: () => empty([]),
    companies: () => empty([]),
    activities: () => empty([]),
  };
  const svc = new ReportsService(
    mongo as never,
    { enqueue: async () => undefined } as never,
    { getService: () => ({ listPipelines: () => of({ list: [] }) }) } as never,
    { getService: () => ({}) } as never,
      { read: async () => [] } as never,
    { get: async () => null, isTrusted: () => false } as never,
    { listForDeal: async () => [], avgDurationByStage: async () => [] } as never,
  );
  svc.onModuleInit();
  return svc;
}

describe('reports: встроенные пресеты (TODO-248/251/501)', () => {
  it('сид заводит все семь пресетов с presetKey (фронт сопоставляет вкладку по ключу)', async () => {
    const store = reportsStore([]);
    const svc = svcWith(store);
    await svc.list('p1', 0, 100);
    // TODO-463: сид идёт upsert'ами по (projectId, presetKey), а не insertOne —
    // ключ пресета живёт в фильтре, документ дополняется $setOnInsert.
    const inserts = (store.bulk[0] ?? [])
      .map((op) => (op as { updateOne?: { filter: Rec; upsert?: boolean } }).updateOne)
      .filter((op): op is { filter: Rec; upsert?: boolean } => !!op?.upsert)
      .map((op) => op.filter);
    expect(inserts.map((d) => d?.presetKey).sort()).toEqual([
      'activity',
      'by_managers',
      'clients',
      'funnel',
      'my_overdue',
      'sales',
      'sources',
    ]);
    expect(inserts.every((d) => !!d?.presetKey)).toBe(true);
  });

  it('уже засеянный проект лечится на месте: старый kind получает свой presetKey, а не дубль', async () => {
    const store = reportsStore([
      { _id: new ObjectId(), projectId: 'p1', kind: 'sales_snapshot', presetKey: null },
      { _id: new ObjectId(), projectId: 'p1', kind: 'deals_by_stage', presetKey: null },
      { _id: new ObjectId(), projectId: 'p1', kind: 'crm_coverage', presetKey: null },
    ]);
    const svc = svcWith(store);
    await svc.list('p1', 0, 100);
    const ops = (store.bulk[0] ?? []).map((op) => (op as { updateOne?: Rec }).updateOne);
    // лечение старых документов — адресный updateOne по _id (без upsert)
    const updates = ops.filter((op) => !!op && !op.upsert);
    // досев недостающих — upsert по (projectId, presetKey) (TODO-463)
    const inserts = ops.filter((op) => !!op && op.upsert === true);
    expect(updates).toHaveLength(3);
    expect(json(updates)).toContain('"presetKey":"sales"');
    // дублей «Продажи» не появляется — досеиваются только недостающие четыре
    expect(inserts).toHaveLength(4);
  });

  it('пресет нельзя ни переименовать, ни удалить (isBuiltin видит presetKey)', async () => {
    const id = new ObjectId();
    const store = reportsStore([
      {
        _id: id,
        projectId: 'p1',
        name: 'Продажи',
        kind: 'sales',
        presetKey: 'sales',
        createdAt: 1,
        updatedAt: 1,
        deletedAt: null,
      },
    ]);
    const svc = svcWith(store);
    await expect(svc.update('p1', id.toString(), 'Взломанное имя')).rejects.toThrow(
      /нельзя изменять/,
    );
    await expect(svc.remove('p1', id.toString())).rejects.toThrow(/нельзя удалить/);
  });

  it('preset_key отдаётся и в определении отчёта, и в ответе прогона', async () => {
    const id = new ObjectId();
    const store = reportsStore([
      {
        _id: id,
        projectId: 'p1',
        name: 'Воронка',
        description: '',
        kind: 'funnel',
        presetKey: 'funnel',
        createdAt: 1,
        updatedAt: 1,
        deletedAt: null,
      },
    ]);
    const svc = svcWith(store);
    const def = await svc.get('p1', id.toString());
    expect(def.preset_key).toBe('funnel');
    const run = await svc.run('p1', id.toString(), undefined, SCOPE_ALL);
    expect(run.preset_key).toBe('funnel');
    expect(JSON.parse(run.data_json).preset_key).toBe('funnel');
  });
});

describe('reports: срезы по менеджерам и отделам приходят в data_json (TODO-249)', () => {
  it('run() отдаёт deals_by_manager и deals_by_department', async () => {
    const id = new ObjectId();
    const store = reportsStore([
      {
        _id: id,
        projectId: 'p1',
        name: 'По менеджерам',
        description: '',
        kind: 'by_managers',
        presetKey: 'by_managers',
        createdAt: 1,
        updatedAt: 1,
        deletedAt: null,
      },
    ]);
    const svc = svcWith(store);
    const run = await svc.run('p1', id.toString(), undefined, SCOPE_ALL);
    const data = JSON.parse(run.data_json) as Rec;
    expect(Array.isArray(data.deals_by_manager)).toBe(true);
    expect(Array.isArray(data.deals_by_department)).toBe(true);
  });
});

describe('reports: params реально сужают выборку (TODO-252)', () => {
  const id = new ObjectId();
  const doc = {
    _id: id,
    projectId: 'p1',
    name: 'Продажи',
    description: '',
    kind: 'sales',
    presetKey: 'sales',
    createdAt: 1,
    updatedAt: 1,
    deletedAt: null,
  };

  it('период/воронка/менеджеры уезжают в $match, а не только в эхо', async () => {
    const calls: Rec[] = [];
    const svc = svcWith(reportsStore([doc]), calls);
    const params = JSON.stringify({
      period: 'custom',
      customFrom: 1_000,
      customTo: 2_000,
      pipelineId: 'pl1',
      managerIds: ['u7'],
    });
    const run = await svc.run('p1', id.toString(), params, SCOPE_ALL);
    const filter = json(calls[0]);
    expect(filter).toContain('"$gte":1000');
    expect(filter).toContain('"pipelineId":"pl1"');
    expect(filter).toContain('"assigneeId":{"$in":["u7"]}');
    // эхо параметров сохранено (клиенты его читают)
    expect(JSON.parse(run.data_json).params).toMatchObject({ pipelineId: 'pl1' });
  });

  it('период «Год» с фронта поддержан (раньше валил прогон в INVALID_ARGUMENT)', async () => {
    const calls: Rec[] = [];
    const svc = svcWith(reportsStore([doc]), calls);
    await expect(
      svc.run('p1', id.toString(), JSON.stringify({ period: 'year' }), SCOPE_ALL),
    ).resolves.toBeDefined();
  });

  it('drill() применяет те же params — записи ячейки согласованы с её числом', async () => {
    const calls: Rec[] = [];
    const svc = svcWith(reportsStore([doc]), calls);
    await svc.drill(
      'p1',
      id.toString(),
      JSON.stringify({ period: 'custom', from: 1_000, to: 2_000 }),
      'stage_id',
      's1',
      10,
      undefined,
      SCOPE_ALL,
    );
    expect(json(calls[0])).toContain('"$gte":1000');
  });

  it('managerIds с неверным типом — INVALID_ARGUMENT (закрытый словарь)', async () => {
    const svc = svcWith(reportsStore([doc]));
    await expect(
      svc.run('p1', id.toString(), JSON.stringify({ managerIds: 'u7' }), SCOPE_ALL),
    ).rejects.toThrow(/managerIds must be an array of strings/);
  });
});

describe('reports: единая таймзона периода и бакетов (TODO-471/502)', () => {
  const svc = new ReportsService({} as never, {} as never, {} as never, {} as never, { read: async () => [] } as never, { get: async () => null, isTrusted: () => false } as never, { listForDeal: async () => [], avgDurationByStage: async () => [] } as never);
  const call = <T>(name: string, ...args: unknown[]): T =>
    (svc as unknown as Record<string, (...a: unknown[]) => T>)[name](...args);

  afterEach(() => {
    delete process.env.STATISTICS_TZ;
  });

  it('«сегодня» начинается в полночь настроенной зоны, а не UTC/локальной зоны процесса', () => {
    process.env.STATISTICS_TZ = 'Europe/Moscow';
    const range = call<{ from: number }>('resolvePeriod', 'today');
    const msk = new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Europe/Moscow',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).format(new Date(range.from));
    expect(msk).toBe('00:00');
  });

  it('первый бакет серии совпадает с датой начала периода (в той же зоне)', () => {
    process.env.STATISTICS_TZ = 'Europe/Moscow';
    const range = call<{ from: number }>('resolvePeriod', 'month');
    expect(call<string>('dayBucket', range.from)).toMatch(/-01$/);
    expect(call<string>('dayBucket', range.from)).toBe(
      new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Moscow' }).format(new Date(range.from)),
    );
  });

  it('по умолчанию (и при нераспознанной зоне) считается UTC — поведение не меняется', () => {
    expect(call<string>('statisticsTz')).toBe('UTC');
    process.env.STATISTICS_TZ = 'Mars/Olympus';
    expect(call<string>('statisticsTz')).toBe('UTC');
    expect(call<string>('dayBucket', Date.UTC(2026, 7, 18, 23, 30))).toBe('2026-08-18');
  });
});
