import { of } from 'rxjs';
import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { StatisticsBffController } from './statistics-bff.controller';
import type { GatewayOutboundMetadataService } from './gateway-outbound-metadata.service';
import type { IdentityResolverService } from './identity-resolver.service';

/**
 * ГРАНИЦА ПРОЕКТА (INV-3): контроллер обязан читать данные РОВНО из того
 * проекта, на котором отработали гейты.
 *
 * Дефект, который фиксирует этот файл: контроллер разрешал projectId в порядке
 * `header → query`, а ProjectAccessGuard/GatewayModuleGuard — в порядке
 * `params → query → header`. Запрос `GET /api/v1/dashboard?projectId=A` с
 * заголовком `x-project-id: B` авторизовался по проекту A (членство, роль,
 * VisibilityScope, enabled-модули, module-policy, ABAC-предикат), а домен
 * звался с `project_id: B` и метадатой проекта B → межпроектный слив дашборда,
 * аналитики, CSV-экспорта (и запись факта `statistics.exported` в журнал
 * чужого проекта).
 *
 * Контракт: домен НИКОГДА не вызывается с id, отличным от авторизованного;
 * расхождение источников — 403, отсутствие id — 400.
 */

const BASE = {
  kpi: [],
  funnel: [],
  sources: [],
  overdue: [],
  upcoming: [],
  recent: [],
  stalled: [],
  as_of: 1,
  partial: false,
  scope_level: 'Только свои',
  period: 'month',
  from: 1,
  to: 2,
};

const METRICS = {
  kpi: [],
  funnel: [],
  sources: [],
  team: [],
  by_department: [],
  by_stage: [],
  as_of: 1,
  partial: false,
  scope_level: 'Только свои',
  period: 'month',
  from: 1,
  to: 2,
};

function makeController() {
  const reports = {
    getDashboard: jest.fn().mockReturnValue(of(BASE)),
    getMetrics: jest.fn().mockReturnValue(of(METRICS)),
  };
  const appendEvent = jest.fn(() => of({ id: 'ev-1' }));
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
  const auditClient = { getService: jest.fn().mockReturnValue({ appendEvent }) } as never;
  const outboundMeta = {
    build: jest.fn((_req: unknown, opts?: { projectId?: string }) => ({
      projectId: opts?.projectId,
    })),
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
  return { ctl, reports, appendEvent, outboundMeta };
}

const req = (over: Record<string, unknown>) =>
  ({ user: { userId: 'u-1' }, headers: {}, ...over }) as never;

describe('StatisticsBffController — projectId только авторизованный (INV-3)', () => {
  it('query=A + header=B: домен не зовётся ни с A, ни с B — 403', async () => {
    const { ctl, reports } = makeController();

    await expect(
      ctl.dashboard(req({ headers: { 'x-project-id': 'B' } }), 'A'),
    ).rejects.toBeInstanceOf(ForbiddenException);

    expect(reports.getDashboard).not.toHaveBeenCalled();
  });

  it('гейт авторизовал A (__projectId) — домен зовётся с A, а не с заголовком', async () => {
    const { ctl, reports, outboundMeta } = makeController();

    await ctl.dashboard(req({ headers: { 'x-project-id': 'A' }, __projectId: 'A' }));

    expect(reports.getDashboard).toHaveBeenCalledTimes(1);
    expect((reports.getDashboard.mock.calls[0] as unknown[])[0]).toMatchObject({
      project_id: 'A',
    });
    expect(outboundMeta.build).toHaveBeenCalledWith(expect.anything(), { projectId: 'A' });
  });

  it('/statistics: query=A + header=B → 403, GetMetrics не вызывается', async () => {
    const { ctl, reports } = makeController();

    await expect(
      ctl.statistics(req({ headers: { 'x-project-id': 'B' } }), 'A'),
    ).rejects.toBeInstanceOf(ForbiddenException);

    expect(reports.getMetrics).not.toHaveBeenCalled();
  });

  it('/statistics/export: query=A + header=B → 403, ни выгрузки, ни записи в аудит', async () => {
    const { ctl, reports, appendEvent } = makeController();
    const res = { header: jest.fn() } as never;

    await expect(
      ctl.export(req({ headers: { 'x-project-id': 'B' } }), res, 'A', 'csv'),
    ).rejects.toBeInstanceOf(ForbiddenException);

    expect(reports.getMetrics).not.toHaveBeenCalled();
    expect(appendEvent).not.toHaveBeenCalled();
  });

  it('экспорт по авторизованному id: и данные, и аудит идут в него', async () => {
    const { ctl, reports, appendEvent } = makeController();
    const res = { header: jest.fn() } as never;

    await ctl.export(req({ headers: { 'x-project-id': 'A' }, __projectId: 'A' }), res, 'A', 'csv');

    expect((reports.getMetrics.mock.calls[0] as unknown[])[0]).toMatchObject({ project_id: 'A' });
    expect(appendEvent).toHaveBeenCalledTimes(1);
    expect((appendEvent.mock.calls[0] as unknown[])[0]).toMatchObject({ entity_id: 'A' });
  });

  it('только заголовок (обычный запрос фронта) — работает как раньше', async () => {
    const { ctl, reports } = makeController();

    await ctl.dashboard(req({ headers: { 'x-project-id': 'p1' } }));

    expect((reports.getDashboard.mock.calls[0] as unknown[])[0]).toMatchObject({
      project_id: 'p1',
    });
  });

  it('источника нет вовсе — 400 PROJECT_ID_REQUIRED, а не 500 из домена', async () => {
    const { ctl, reports } = makeController();

    await expect(ctl.dashboard(req({}))).rejects.toBeInstanceOf(BadRequestException);
    expect(reports.getDashboard).not.toHaveBeenCalled();
  });
});
