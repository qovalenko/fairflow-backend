import { of } from 'rxjs';
import { StatisticsBffController } from './statistics-bff.controller';
import type { GatewayOutboundMetadataService } from './gateway-outbound-metadata.service';
import type { IdentityResolverService } from './identity-resolver.service';

/**
 * TODO-498 (gateway-половина) — размеры списков дашборда доезжают до виджета.
 *
 * Домен режет каждый список дашборда лимитом (`.limit(5)` для просроченных /
 * ближайших / застрявших, `.limit(10)` для недавних), поэтому виджет, считавший
 * остаток как «длина массива − показано», получал тождественный ноль и индикатор
 * «+ ещё N» не показывался никогда. Счётчик приезжает из домена отдельными
 * полями `*_total` — здесь зафиксировано, что BFF их НЕ теряет (класс дефекта
 * «домен умеет, а до пользователя не доходит»), переводит в camelCase и
 * выдерживает обе формы int64 (число и protobuf Long).
 *
 * Пока reports поля не отдаёт (старая сборка домена), в контракте остаётся длина
 * усечённого списка — ровно AS-IS-поведение, а не выдуманное число.
 */

const activity = (id: string) => ({ id, title: id, due_at: 1, owner_id: 'u-1', deep_link: '' });
const stalled = (id: string) => ({ id, name: id, amount: 1, owner_id: 'u-1', stage_id: 'st-1' });

const BASE_DASHBOARD = {
  kpi: [],
  funnel: [],
  sources: [],
  overdue: [activity('a-1'), activity('a-2')],
  upcoming: [activity('a-3')],
  recent: [activity('a-4')],
  stalled: [stalled('d-1')],
  as_of: 1_700_000_000_000,
  partial: false,
  scope_level: 'Вся организация',
  period: 'month',
  from: 1,
  to: 2,
};

const REQ = { headers: { 'x-project-id': 'p1' }, user: { userId: 'u-1' } } as never;

function makeController(dashboard: Record<string, unknown>) {
  const reports = {
    getDashboard: jest.fn().mockReturnValue(of(dashboard)),
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

describe('StatisticsBffController — размеры списков дашборда (TODO-498)', () => {
  it('*_total домена доезжают в camelCase-полях ответа', async () => {
    const ctl = makeController({
      ...BASE_DASHBOARD,
      overdue_total: 17,
      upcoming_total: 9,
      recent_total: 42,
      stalled_total: 3,
    });

    const res = (await ctl.dashboard(REQ)) as Record<string, unknown>;

    expect(res).toMatchObject({
      overdueTotal: 17,
      upcomingTotal: 9,
      recentTotal: 42,
      stalledTotal: 3,
    });
    // Сами списки остаются усечёнными — виджет рисует их, а «+ ещё N» считает
    // как total − показано.
    expect((res.overdue as unknown[]).length).toBe(2);
  });

  it('int64 в виде protobuf Long тоже разворачивается в число (грабли loader-опций)', async () => {
    const ctl = makeController({
      ...BASE_DASHBOARD,
      overdue_total: { low: 17, high: 0, unsigned: false },
      recent_total: '42',
    });

    const res = (await ctl.dashboard(REQ)) as Record<string, unknown>;

    expect(res.overdueTotal).toBe(17);
    expect(res.recentTotal).toBe(42);
  });

  it('домен без *_total → длина усечённого списка (AS-IS, без выдуманных чисел)', async () => {
    const ctl = makeController({ ...BASE_DASHBOARD });

    const res = (await ctl.dashboard(REQ)) as Record<string, unknown>;

    expect(res).toMatchObject({
      overdueTotal: 2,
      upcomingTotal: 1,
      recentTotal: 1,
      stalledTotal: 1,
    });
  });

  it('total меньше собственного списка не занижает счётчик', async () => {
    const ctl = makeController({ ...BASE_DASHBOARD, overdue_total: 0 });

    const res = (await ctl.dashboard(REQ)) as Record<string, unknown>;

    expect(res.overdueTotal).toBe(2);
  });
});
