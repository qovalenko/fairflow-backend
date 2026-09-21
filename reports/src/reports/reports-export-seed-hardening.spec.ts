import { ObjectId } from 'mongodb';
import { of } from 'rxjs';
import { ReportsService } from './reports.service';
import type { VisibilityScope } from '@fairflow/shared';

/**
 * Волна «Статистика», доводка домена (TODO-297/463/467/475).
 *
 * Проверяется не «ответ непустой», а конкретные артефакты, в которых жили
 * дефекты: байты CSV-выгрузки, операции сида в bulkWrite, `$match` детализации
 * и ключ идемпотентности факта, уезжающего в outbox.
 */

type Rec = Record<string, unknown>;

const SCOPE_ALL: VisibilityScope = {
  mode: 'all',
  level: 'all',
  selfId: 'u1',
  ownerIds: [],
  sharedRecordIds: [],
} as VisibilityScope;

const REPORT_ID = new ObjectId();

const REPORT_DOC: Rec = {
  _id: REPORT_ID,
  projectId: 'p1',
  name: 'Продажи',
  description: '',
  kind: 'sales',
  presetKey: 'sales',
  createdAt: 1,
  updatedAt: 1,
  deletedAt: null,
};

interface Harness {
  svc: ReportsService;
  outbox: Rec[];
  indexes: Array<{ keys: Rec; options?: Rec }>;
  bulk: unknown[][];
  dealsFilters: Rec[];
}

function harness(
  opts: {
    dealRows?: Rec[];
    reportDocs?: Rec[];
    bulkWriteError?: unknown;
    createIndexError?: unknown;
  } = {},
): Harness {
  const outbox: Rec[] = [];
  const indexes: Array<{ keys: Rec; options?: Rec }> = [];
  const bulk: unknown[][] = [];
  const dealsFilters: Rec[] = [];
  const docs = opts.reportDocs ?? [REPORT_DOC];

  const cursor = (rows: Rec[]): Rec => ({
    sort: () => cursor(rows),
    limit: () => cursor(rows),
    skip: () => cursor(rows),
    project: () => cursor(rows),
    toArray: async () => rows,
  });

  const reportsColl = {
    countDocuments: async () => docs.length,
    find: () => cursor(docs),
    findOne: async (filter: Rec) =>
      docs.find((d) => String(d._id) === String((filter as { _id?: unknown })._id)) ?? null,
    updateOne: async () => ({}),
    aggregate: () => ({ toArray: async () => [] }),
    createIndex: async (keys: Rec, options?: Rec) => {
      if (opts.createIndexError) throw opts.createIndexError;
      indexes.push({ keys, options });
      return 'ix';
    },
    bulkWrite: async (ops: unknown[]) => {
      bulk.push(ops);
      if (opts.bulkWriteError) throw opts.bulkWriteError;
      return {};
    },
  };

  const dealsColl = {
    countDocuments: async (f: Rec) => {
      dealsFilters.push(f);
      return opts.dealRows?.length ?? 0;
    },
    aggregate: (p: unknown[]) => {
      dealsFilters.push((p[0] as Rec).$match as Rec);
      return { toArray: async () => opts.dealRows ?? [] };
    },
    find: (f: Rec = {}) => {
      dealsFilters.push(f);
      return cursor([]);
    },
  };

  const emptyColl = {
    countDocuments: async () => 0,
    aggregate: () => ({ toArray: async () => [] }),
    find: () => cursor([]),
  };

  const mongo = {
    reports: () => reportsColl,
    deals: () => dealsColl,
    orders: () => emptyColl,
    contacts: () => emptyColl,
    companies: () => emptyColl,
    activities: () => emptyColl,
  };

  const svc = new ReportsService(
    mongo as never,
    {
      enqueue: async (intent: Rec) => {
        outbox.push(intent);
      },
    } as never,
    { getService: () => ({ listPipelines: () => of({ list: [] }) }) } as never,
    { getService: () => ({}) } as never,
    { read: async () => [] } as never,
    { get: async () => null, isTrusted: () => false } as never,
    { listForDeal: async () => [], avgDurationByStage: async () => [] } as never,
  );
  svc.onModuleInit();
  return { svc, outbox, indexes, bulk, dealsFilters };
}

/** ensureReportIndexes — fire-and-forget: даём микрозадачам отработать. */
const flush = () => new Promise((r) => setImmediate(r));

describe('TODO-297: CSV-экспорт отчёта экранирует значения', () => {
  it('запятая и кавычка в stage_id не рвут колонки, а формула обезврежена', async () => {
    const h = harness({
      dealRows: [
        { _id: 'a,b', count: 2, amount: 10 },
        { _id: '=HYPERLINK("http://evil","click")', count: 1, amount: 5 },
        { _id: 'нормальная "стадия"', count: 1, amount: 1 },
      ],
    });
    const res = await h.svc.export('p1', REPORT_ID.toString(), 'csv', undefined, SCOPE_ALL);
    const csv = Buffer.from(res.payload_base64, 'base64').toString('utf8');
    const lines = csv.split('\n');

    // 1) значение с запятой закавычено — колонок в строке столько же, сколько в шапке
    expect(lines).toContain('deals_by_stage,"a,b",2:10');
    // 2) formula injection обезврежена ведущим апострофом И закавычена (внутри запятые)
    expect(csv).toContain('\'=HYPERLINK(""http://evil"",""click"")');
    expect(csv).not.toContain(',=HYPERLINK');
    // 3) кавычки внутри значения удвоены
    expect(csv).toContain('"нормальная ""стадия"""');
    // 4) числовые ячейки не испорчены апострофом
    expect(csv).toContain('totals,deals_count,3');
  });
});

describe('TODO-463: reports_definitions — индексы и сид без гонки', () => {
  it('создаётся уникальный индекс (projectId, presetKey) и индекс под list()', async () => {
    const h = harness();
    await flush();
    const uk = h.indexes.find((i) => i.options?.name === 'reports_def_preset_uk');
    expect(uk).toBeDefined();
    expect(uk?.keys).toEqual({ projectId: 1, presetKey: 1 });
    expect(uk?.options?.unique).toBe(true);
    // partial: пользовательские отчёты с presetKey=null не конфликтуют друг с другом
    expect(uk?.options?.partialFilterExpression).toEqual({ presetKey: { $type: 'string' } });
    const list = h.indexes.find((i) => i.options?.name === 'reports_def_list');
    expect(list?.keys).toEqual({ projectId: 1, deletedAt: 1, updatedAt: -1 });
    // TODO-466: у «личной» ветки предиката доступа (`createdBy = viewer`) свой
    // индекс и своё ИМЯ — переопределить reports_def_list другим ключом нельзя
    // (createIndex падает IndexKeySpecsConflict, а он тут проглатывается warn'ом,
    // и на существующих БД правка тихо не применилась бы).
    const owner = h.indexes.find((i) => i.options?.name === 'reports_def_owner');
    expect(owner?.keys).toEqual({ projectId: 1, deletedAt: 1, createdBy: 1, updatedAt: -1 });
  });

  it('падение createIndex не роняет сервис (старые дубли в проде)', async () => {
    const h = harness({ createIndexError: new Error('IndexKeySpecsConflict') });
    await flush();
    await expect(h.svc.list('p1', 0, 25)).resolves.toBeDefined();
  });

  it('сид досевает пресеты upsert-ом по (projectId, presetKey), а не insertOne', async () => {
    const h = harness({ reportDocs: [] });
    await h.svc.list('p1', 0, 25);
    const ops = (h.bulk[0] ?? []) as Array<{ updateOne?: Rec; insertOne?: Rec }>;
    expect(ops.every((op) => !op.insertOne)).toBe(true);
    const first = ops[0].updateOne as { filter: Rec; update: Rec; upsert?: boolean };
    expect(first.upsert).toBe(true);
    expect(Object.keys(first.filter).sort()).toEqual(['presetKey', 'projectId']);
    // projectId/presetKey Mongo добавит из фильтра — в $setOnInsert их быть не должно
    const setOnInsert = (first.update as { $setOnInsert: Rec }).$setOnInsert;
    expect(setOnInsert.projectId).toBeUndefined();
    expect(setOnInsert.presetKey).toBeUndefined();
  });

  it('E11000 от параллельного сида не превращается в ошибку запроса', async () => {
    const h = harness({
      reportDocs: [],
      bulkWriteError: Object.assign(new Error('bulk write failed'), {
        writeErrors: [{ code: 11000 }, { code: 11000 }],
      }),
    });
    await expect(h.svc.list('p1', 0, 25)).resolves.toBeDefined();
  });

  it('прочая ошибка bulkWrite наружу не глотается', async () => {
    const h = harness({
      reportDocs: [],
      bulkWriteError: Object.assign(new Error('no space left'), { code: 14031 }),
    });
    await expect(h.svc.list('p1', 0, 25)).rejects.toThrow(/no space left/);
  });
});

describe('TODO-467: детализация фильтрует стадию индексируемым $or, а не $expr', () => {
  it('в $match детализации нет $expr', async () => {
    const h = harness();
    await h.svc.drill(
      'p1',
      REPORT_ID.toString(),
      undefined,
      'stage_id',
      's-1',
      50,
      undefined,
      SCOPE_ALL,
    );
    const filters = JSON.stringify(h.dealsFilters);
    expect(filters).not.toContain('$expr');
    expect(filters).toContain('{"stageId":"s-1"}');
    expect(filters).toContain('{"stage_id":"s-1"}');
  });
});

describe('TODO-475: ключ идемпотентности факта детерминирован', () => {
  it('ретрай ОДНОГО вызова (тот же call-id) даёт ОДИН ключ', async () => {
    const h = harness();
    await h.svc.run('p1', REPORT_ID.toString(), undefined, SCOPE_ALL, 'u1', true, undefined, 'call-1');
    await h.svc.run('p1', REPORT_ID.toString(), undefined, SCOPE_ALL, 'u1', true, undefined, 'call-1');
    expect(h.outbox).toHaveLength(2);
    expect(h.outbox[0].idempotencyKey).toBe(h.outbox[1].idempotencyKey);
    expect(String(h.outbox[0].idempotencyKey)).toContain('report.generated:');
    expect(String(h.outbox[0].idempotencyKey)).toContain('call-1');
  });

  it('разные вызовы — разные ключи (дедуп не схлопывает разные прогоны)', async () => {
    const h = harness();
    await h.svc.run('p1', REPORT_ID.toString(), undefined, SCOPE_ALL, 'u1', true, undefined, 'call-1');
    await h.svc.run('p1', REPORT_ID.toString(), undefined, SCOPE_ALL, 'u1', true, undefined, 'call-2');
    expect(h.outbox[0].idempotencyKey).not.toBe(h.outbox[1].idempotencyKey);
  });

  it('прогон и экспорт одного отчёта в одном вызове не считаются дублем', async () => {
    const h = harness();
    await h.svc.run('p1', REPORT_ID.toString(), undefined, SCOPE_ALL, 'u1', true, undefined, 'call-1');
    await h.svc.export(
      'p1',
      REPORT_ID.toString(),
      'csv',
      undefined,
      SCOPE_ALL,
      'u1',
      undefined,
      'call-1',
    );
    // export вызывает run(emitGenerated=false) → ровно два факта, разного типа
    expect(h.outbox.map((e) => e.type)).toEqual(['report.generated', 'statistics.exported']);
    expect(h.outbox[0].idempotencyKey).not.toBe(h.outbox[1].idempotencyKey);
  });

  it('без call-id ключа нет — шина падает на messageId (прежнее поведение)', async () => {
    const h = harness();
    await h.svc.run('p1', REPORT_ID.toString(), undefined, SCOPE_ALL, 'u1');
    expect(h.outbox[0].idempotencyKey).toBeUndefined();
  });
});
