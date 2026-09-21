import { of } from 'rxjs';
import { StatisticsBffController } from './statistics-bff.controller';
import type { GatewayOutboundMetadataService } from './gateway-outbound-metadata.service';
import type { IdentityResolverService } from './identity-resolver.service';

/**
 * TODO-478 (gateway-половина) — сравнение с прошлым периодом доезжает до KPI.
 *
 * Домен считает `previous_value`/`growth_rate` по окну той же длины, сдвинутому
 * назад (`reports.service.ts#kpiCell`), фронт рисует по ним индикатор роста
 * (`DashboardWidgets.tsx:121-125`, доля → проценты, TODO-504). Между ними —
 * ровно одна проекция, `metricValueFe`: стоит ей потерять поле (а до TODO-498
 * такой класс дефекта в этом контроллере уже случался — «домен умеет, а до
 * пользователя не доходит»), и под каждым KPI снова появится «▲ +0%».
 *
 * Здесь эта проекция закреплена: оба поля переходят в camelCase, ноль и падение
 * не превращаются в «нет данных», а отсутствие полей у старой сборки домена не
 * подменяется выдуманными числами (фронт сам деградирует до 0).
 */

const REQ = { headers: { 'x-project-id': 'p1' }, user: { userId: 'u-1' } } as never;

const BASE_DASHBOARD = {
  kpi: [],
  funnel: [],
  sources: [],
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

function makeController(kpi: Record<string, unknown>[]) {
  const reports = {
    getDashboard: jest.fn().mockReturnValue(of({ ...BASE_DASHBOARD, kpi })),
    getMetrics: jest.fn().mockReturnValue(of({})),
  };
  const reportsClient = { getService: jest.fn().mockReturnValue(reports) } as never;
  const controlClient = {
    getService: jest.fn().mockReturnValue({ listDepartments: jest.fn(() => of({ list: [] })) }),
  } as never;
  const ordersClient = {
    getService: jest.fn().mockReturnValue({ listOrderTypes: jest.fn(() => of({ list: [] })) }),
  } as never;
  const pipeClient = {
    getService: jest.fn().mockReturnValue({
      listPipelines: jest.fn(() => of({ list: [] })),
      listDealSources: jest.fn(() => of({ list: [] })),
    }),
  } as never;
  const auditClient = {
    getService: jest.fn().mockReturnValue({ appendEvent: jest.fn(() => of({ id: 'ev-1' })) }),
  } as never;
  const outboundMeta = { build: jest.fn(() => ({})) } as unknown as GatewayOutboundMetadataService;
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
  return ctl;
}

type KpiFe = { key: string; previousValue?: number; growthRate?: number; value?: number };

const kpiOf = async (kpi: Record<string, unknown>[]): Promise<KpiFe[]> =>
  ((await makeController(kpi).dashboard(REQ)) as { kpi: KpiFe[] }).kpi;

describe('StatisticsBffController — previous_value/growth_rate KPI (TODO-478)', () => {
  it('оба поля домена доезжают до фронта в camelCase', async () => {
    const [cell] = await kpiOf([
      {
        key: 'deals_amount',
        label: 'Сумма сделок',
        value: 150,
        previous_value: 100,
        growth_rate: 0.5,
      },
    ]);

    expect(cell).toEqual({
      key: 'deals_amount',
      label: 'Сумма сделок',
      value: 150,
      previousValue: 100,
      growthRate: 0.5,
    });
  });

  it('падение (отрицательный growth_rate) не теряет знак', async () => {
    const [cell] = await kpiOf([
      { key: 'deals_count', label: 'Сделки', value: 4, previous_value: 8, growth_rate: -0.5 },
    ]);

    expect(cell.growthRate).toBe(-0.5);
    expect(cell.previousValue).toBe(8);
  });

  it('честный ноль прошлого периода остаётся нулём (а не «нет данных»)', async () => {
    // Домен так помечает «предыдущего окна не было»: previous=0 → growth=0.
    const [cell] = await kpiOf([
      { key: 'orders_count', label: 'Продажи', value: 3, previous_value: 0, growth_rate: 0 },
    ]);

    expect(cell.previousValue).toBe(0);
    expect(cell.growthRate).toBe(0);
  });

  it('старая сборка домена без полей → фронт получает undefined, а не выдуманный рост', async () => {
    const [cell] = await kpiOf([{ key: 'deals_count', label: 'Сделки', value: 3 }]);

    expect(cell.value).toBe(3);
    expect(cell.previousValue).toBeUndefined();
    expect(cell.growthRate).toBeUndefined();
  });

  it('поля проставляются каждой ячейке KPI, а не только первой', async () => {
    const cells = await kpiOf([
      { key: 'a', label: 'A', value: 1, previous_value: 2, growth_rate: -0.5 },
      { key: 'b', label: 'B', value: 4, previous_value: 2, growth_rate: 1 },
    ]);

    expect(cells.map((c) => [c.key, c.previousValue, c.growthRate])).toEqual([
      ['a', 2, -0.5],
      ['b', 2, 1],
    ]);
  });
});
