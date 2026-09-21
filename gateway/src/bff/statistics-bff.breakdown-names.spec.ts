import { of, throwError } from 'rxjs';
import { StatisticsBffController } from './statistics-bff.controller';
import type { GatewayOutboundMetadataService } from './gateway-outbound-metadata.service';
import type { IdentityResolverService } from './identity-resolver.service';

/**
 * TODO-269 / TODO-470: менеджеров и отделы gateway уже резолвил, а срезы
 * «воронка» и «источники» доезжали до экрана СЫРЫМИ id — домен reports (Mongo)
 * группирует по `stageId`/`sourceId` и справочников pipe не видит, поэтому
 * кладёт один и тот же id и в `key`, и в `label`.
 *
 * Здесь зафиксировано: строка воронки/источника несёт НАЗВАНИЕ в `label`, `key`
 * при этом остаётся id (по нему drill, FR-MSTAT-24), недоступность pipe не рушит
 * срез (fail-soft), справочник берётся один раз на TTL и в разрезе проекта.
 *
 * TODO-297 (gateway-половина): значения в CSV не только кавычатся, но и не
 * исполняются как формула при открытии выгрузки в Excel/LibreOffice.
 */

const FUNNEL = [
  { key: 'st-1', label: 'st-1', count: 10, amount: 1000, conversion: 1 },
  { key: 'st-gone', label: 'st-gone', count: 2, amount: 20, conversion: 0.2 },
];
const SOURCES = [
  { key: 'src-1', label: 'src-1', count: 5, amount: 500, suppressed: false },
  { key: 'unknown', label: 'Прочее', count: 1, amount: 10, suppressed: false },
];

const METRICS = {
  sales: [],
  funnel: FUNNEL,
  sources: SOURCES,
  team: [],
  by_department: [],
  as_of: 1_700_000_000_000,
  partial: false,
  scope_level: 'Вся организация',
  period: 'month',
  from: 1,
  to: 2,
  slices: ['funnel', 'sources'],
};

const DASHBOARD = {
  kpi: [],
  funnel: FUNNEL.map(({ key, label, count, amount }) => ({
    key,
    label,
    count,
    amount,
    suppressed: false,
  })),
  sources: SOURCES,
  overdue: [],
  upcoming: [],
  recent: [],
  stalled: [],
  as_of: 1_700_000_000_000,
  partial: false,
  scope_level: 'Вся организация',
  period: 'month',
  from: 1,
  to: 2,
};

const REQ = { headers: { 'x-project-id': 'p1' }, user: { userId: 'viewer-1' } } as never;
const REQ_P2 = { headers: { 'x-project-id': 'p2' }, user: { userId: 'viewer-1' } } as never;

function makeController(opts?: { pipeFail?: boolean; stageName?: string; sourceName?: string }) {
  const reports = {
    getMetrics: jest.fn().mockReturnValue(of(METRICS)),
    getDashboard: jest.fn().mockReturnValue(of(DASHBOARD)),
  };
  const listPipelines = jest.fn().mockImplementation(() =>
    opts?.pipeFail
      ? throwError(() => new Error('pipe down'))
      : of({
          list: [
            {
              id: 'pl-1',
              name: 'Основная',
              stages: [
                { id: 'st-1', name: opts?.stageName ?? 'Переговоры', order: 1 },
                { id: 'st-2', name: 'Счёт', order: 2 },
              ],
            },
          ],
        }),
  );
  const listDealSources = jest
    .fn()
    .mockImplementation(() =>
      opts?.pipeFail
        ? throwError(() => new Error('pipe down'))
        : of({ list: [{ id: 'src-1', name: opts?.sourceName ?? 'Сайт, форма' }] }),
    );
  const pipe = { listPipelines, listDealSources };

  const reportsClient = { getService: jest.fn().mockReturnValue(reports) } as never;
  const controlClient = {
    getService: jest.fn().mockReturnValue({ listDepartments: jest.fn(() => of({ list: [] })) }),
  } as never;
  const ordersClient = {
    getService: jest.fn().mockReturnValue({ listOrderTypes: jest.fn(() => of({ list: [] })) }),
  } as never;
  const pipeClient = { getService: jest.fn().mockReturnValue(pipe) } as never;
  const appendEvent = jest.fn().mockReturnValue(of({ id: 'ev-1' }));
  const auditClient = { getService: jest.fn().mockReturnValue({ appendEvent }) } as never;
  const outboundMeta = {
    build: jest.fn(() => ({ md: true })),
  } as unknown as GatewayOutboundMetadataService;
  const identity = {
    resolveNames: jest.fn().mockResolvedValue(new Map()),
  } as unknown as IdentityResolverService;

  const ctl = new StatisticsBffController(
    reportsClient,
    controlClient,
    ordersClient,
    outboundMeta,
    identity,
    pipeClient,
    auditClient,
  );
  ctl.onModuleInit();
  return { ctl, listPipelines, listDealSources, appendEvent };
}

describe('StatisticsBffController — имена стадий и источников (TODO-269/470, FR-MSTAT-17)', () => {
  it('GET /statistics: label стадии/источника — название, key остаётся id', async () => {
    const { ctl } = makeController();

    const res = (await ctl.statistics(REQ)) as {
      funnel: Array<Record<string, unknown>>;
      sources: Array<Record<string, unknown>>;
    };

    expect(res.funnel[0]).toMatchObject({ key: 'st-1', label: 'Переговоры', count: 10 });
    expect(res.sources[0]).toMatchObject({ key: 'src-1', label: 'Сайт, форма', count: 5 });
  });

  it('GET /dashboard: воронка и источники дашборда тоже с названиями', async () => {
    const { ctl } = makeController();

    const res = (await ctl.dashboard(REQ)) as {
      funnel: Array<Record<string, unknown>>;
      sources: Array<Record<string, unknown>>;
    };

    expect(res.funnel[0]).toMatchObject({ key: 'st-1', label: 'Переговоры' });
    expect(res.sources[0]).toMatchObject({ key: 'src-1', label: 'Сайт, форма' });
  });

  it('id без записи в справочнике не подменяется фейком: остаётся label домена', async () => {
    const { ctl } = makeController();

    const res = (await ctl.statistics(REQ)) as {
      funnel: Array<Record<string, unknown>>;
      sources: Array<Record<string, unknown>>;
    };

    // удалённая стадия — id как был.
    expect(res.funnel[1]).toMatchObject({ key: 'st-gone', label: 'st-gone', count: 2 });
    // источник свободным текстом/без источника — подпись домена («Прочее»).
    expect(res.sources[1]).toMatchObject({ key: 'unknown', label: 'Прочее' });
  });

  it('pipe недоступен → срез отдаётся с id и цифрами (fail-soft)', async () => {
    const { ctl } = makeController({ pipeFail: true });

    const res = (await ctl.statistics(REQ)) as {
      funnel: Array<Record<string, unknown>>;
      sources: Array<Record<string, unknown>>;
    };

    expect(res.funnel[0]).toMatchObject({ key: 'st-1', label: 'st-1', count: 10, amount: 1000 });
    expect(res.sources[0]).toMatchObject({ key: 'src-1', label: 'src-1', count: 5 });
  });

  it('справочники берутся один раз на TTL и кэшируются в разрезе проекта', async () => {
    const { ctl, listPipelines, listDealSources } = makeController();

    await ctl.statistics(REQ);
    await ctl.statistics(REQ);
    expect(listPipelines).toHaveBeenCalledTimes(1);
    expect(listDealSources).toHaveBeenCalledTimes(1);
    expect(listPipelines).toHaveBeenCalledWith({ project_id: 'p1' }, expect.anything());

    // другой проект — свой справочник (кэш не протекает между проектами).
    await ctl.statistics(REQ_P2);
    expect(listPipelines).toHaveBeenCalledTimes(2);
    expect(listPipelines).toHaveBeenLastCalledWith({ project_id: 'p2' }, expect.anything());
  });

  it('домен уже прислал подпись (label ≠ key) → gateway не ходит в pipe и не переписывает её', async () => {
    const { ctl, listPipelines, listDealSources } = makeController();
    // Домен научился резолвить сам: подписи приехали готовыми.
    (ctl as unknown as { reports: { getMetrics: jest.Mock } }).reports.getMetrics = jest
      .fn()
      .mockReturnValue(
        of({
          ...METRICS,
          funnel: [{ key: 'st-1', label: 'Квалификация', count: 10, amount: 1000, conversion: 1 }],
          sources: [{ key: 'src-1', label: 'Реклама', count: 5, amount: 500, suppressed: false }],
        }),
      );

    const res = (await ctl.statistics(REQ)) as {
      funnel: Array<Record<string, unknown>>;
      sources: Array<Record<string, unknown>>;
    };

    expect(res.funnel[0]).toMatchObject({ key: 'st-1', label: 'Квалификация' });
    expect(res.sources[0]).toMatchObject({ key: 'src-1', label: 'Реклама' });
    expect(listPipelines).not.toHaveBeenCalled();
    expect(listDealSources).not.toHaveBeenCalled();
  });

  it('выгрузка (CSV/JSON) несёт те же названия, что и экран', async () => {
    const { ctl } = makeController();
    const res = { header: jest.fn() } as never;

    const csv = ((await ctl.export(REQ, res, undefined, 'csv')) as Buffer).toString('utf8');
    expect(csv).toContain('funnel,st-1,10,1000,Переговоры');
    // запятая в названии источника экранируется кавычками, а не рвёт строку.
    expect(csv).toContain('sources,src-1,5,500,"Сайт, форма"');

    const summary = JSON.parse(
      ((await ctl.export(REQ, res, undefined, 'json')) as Buffer).toString('utf8'),
    ) as { funnel: Array<Record<string, unknown>>; sources: Array<Record<string, unknown>> };
    expect(summary.funnel[0]).toMatchObject({ key: 'st-1', label: 'Переговоры' });
    expect(summary.sources[0]).toMatchObject({ key: 'src-1', label: 'Сайт, форма' });
  });
});

describe('StatisticsBffController — экспорт оставляет след в аудите (TODO-500, FR-MSTAT-23)', () => {
  const REQ_SCOPED = {
    headers: { 'x-project-id': 'p1' },
    user: { userId: 'u-1' },
    __visibilityScope: 'eyJsZXZlbCI6Im93biJ9',
  } as never;

  it('после успешной выгрузки пишется statistics.exported без PII и без цифр', async () => {
    const { ctl, appendEvent } = makeController();
    const res = { header: jest.fn() } as never;

    await ctl.export(REQ_SCOPED, res, undefined, 'csv');

    expect(appendEvent).toHaveBeenCalledTimes(1);
    const [body] = appendEvent.mock.calls[0] as [Record<string, unknown>];
    expect(body).toMatchObject({
      project_id: 'p1',
      event_name: 'statistics.exported',
      entity_type: 'statistics',
      entity_id: 'p1',
    });
    const payload = JSON.parse(String(body.payload_json)) as Record<string, unknown>;
    expect(payload).toMatchObject({
      format: 'csv',
      scopeLevel: 'Вся организация',
      slices: ['funnel', 'sources'],
    });
    // отпечаток scope есть, но самого scope (id владельцев/записей) в журнале нет.
    expect(String(payload.scopeHash)).toMatch(/^[0-9a-f]{16}$/);
    expect(JSON.stringify(payload)).not.toContain('eyJsZXZlbCI6Im93biJ9');
    // актор в теле не передаётся: audit берёт его из проверенной метадаты.
    expect(body.actor_id).toBeUndefined();
  });

  it('format=json тоже журналируется, формат различается', async () => {
    const { ctl, appendEvent } = makeController();
    const res = { header: jest.fn() } as never;

    await ctl.export(REQ_SCOPED, res, undefined, 'json');

    const [body] = appendEvent.mock.calls[0] as [Record<string, unknown>];
    expect(JSON.parse(String(body.payload_json))).toMatchObject({ format: 'json' });
  });

  it('audit недоступен → пользователь всё равно получает файл (fail-soft)', async () => {
    const { ctl, appendEvent } = makeController();
    appendEvent.mockReturnValue(throwError(() => new Error('audit down')));
    const res = { header: jest.fn() } as never;

    const buf = (await ctl.export(REQ_SCOPED, res, undefined, 'csv')) as Buffer;

    expect(buf.toString('utf8').split('\n')[0]).toBe('section,key,count,amount,label');
  });
});

describe('StatisticsBffController — CSV: экранирование и formula injection (TODO-297)', () => {
  it('значение-формула обезврежено ведущим апострофом, кавычка/перевод строки экранированы', async () => {
    const { ctl } = makeController({
      stageName: '=HYPERLINK("http://evil","click")',
      sourceName: 'Реклама\n"Яндекс"',
    });
    const res = { header: jest.fn() } as never;

    const csv = ((await ctl.export(REQ, res, undefined, 'csv')) as Buffer).toString('utf8');

    // ячейка начинается с апострофа И закавычена (внутри есть кавычки/запятые).
    expect(csv).toContain(`funnel,st-1,10,1000,"'=HYPERLINK(""http://evil"",""click"")"`);
    // перевод строки внутри значения не рвёт CSV-строку: он внутри кавычек.
    expect(csv).toContain('sources,src-1,5,500,"Реклама\n""Яндекс"""');
    // заголовок и число колонок не поехали.
    expect(csv.split('\n')[0]).toBe('section,key,count,amount,label');
  });

  it('числовые значения не портятся апострофом', async () => {
    const { ctl } = makeController({ stageName: '-5' });
    const res = { header: jest.fn() } as never;

    const csv = ((await ctl.export(REQ, res, undefined, 'csv')) as Buffer).toString('utf8');

    expect(csv).toContain('funnel,st-1,10,1000,-5');
  });
});
