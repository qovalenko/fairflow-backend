import { of, throwError } from 'rxjs';
import { ReportRunNamesService } from './report-run-names.service';
import type { GatewayOutboundMetadataService } from './gateway-outbound-metadata.service';
import type { IdentityResolverService } from './identity-resolver.service';

/**
 * TODO-470 (остаток по отчётам): менеджеров и отделы gateway в результат прогона
 * уже подписывал, а срезы по стадиям — `deals_by_stage[].stage_id` /
 * `orders_by_stage[].stage_id` из reports.service.buildSummary — доезжали до
 * вкладки отчёта СЫРЫМ id: домен reports (Mongo) справочника стадий из pipe не
 * видит. Здесь зафиксирована вторая половина: строка среза несёт `stage_name`,
 * сам `stage_id` остаётся нетронутым (по нему drill, primaryDimension='stage_id'),
 * недоступность pipe не рушит прогон, справочник берётся один раз на TTL и в
 * разрезе проекта, а projectId — только из маршрута/заголовка, не из тела.
 */

const RUN = (data: Record<string, unknown>) => ({
  report_id: 'r-1',
  data_json: JSON.stringify(data),
  generated_at: 1_700_000_000_000,
});

const SUMMARY = {
  totals: { deals_count: 3 },
  deals_by_stage: [
    { stage_id: 'st-1', count: 2, amount: 200 },
    { stage_id: 'st-gone', count: 1, amount: 100 },
  ],
  orders_by_stage: [{ stage_id: 'st-2', count: 1 }],
};

const REQ = {
  headers: { 'x-project-id': 'p1' },
  query: { projectId: 'p1' },
  user: { userId: 'u-1' },
} as never;

function makeService(opts?: { pipeFail?: boolean }) {
  const listPipelines = jest.fn().mockImplementation(() =>
    opts?.pipeFail
      ? throwError(() => new Error('pipe down'))
      : of({
          list: [
            {
              id: 'pl-1',
              name: 'Основная',
              stages: [
                { id: 'st-1', name: 'Переговоры', order: 1 },
                { id: 'st-2', name: 'Счёт', order: 2 },
              ],
            },
          ],
        }),
  );
  const controlClient = {
    getService: jest.fn().mockReturnValue({ listDepartments: jest.fn(() => of({ list: [] })) }),
  } as never;
  const pipeClient = { getService: jest.fn().mockReturnValue({ listPipelines }) } as never;
  const outboundMeta = {
    build: jest.fn(() => ({ md: true })),
  } as unknown as GatewayOutboundMetadataService;
  const identity = {
    resolveNames: jest.fn().mockResolvedValue(new Map()),
  } as unknown as IdentityResolverService;

  const svc = new ReportRunNamesService(controlClient, pipeClient, outboundMeta, identity);
  svc.onModuleInit();
  return { svc, listPipelines, outboundMeta };
}

/** Разбор обогащённого прогона обратно в объект. */
const dataOf = (run: Record<string, unknown>) =>
  JSON.parse(String(run.data_json)) as Record<string, unknown>;

describe('ReportRunNamesService — подписи стадий в прогоне отчёта (TODO-470)', () => {
  it('deals_by_stage/orders_by_stage получают stage_name, stage_id не меняется', async () => {
    const { svc } = makeService();

    const out = await svc.enrichRunResult(REQ, RUN(SUMMARY) as Record<string, unknown>);
    const data = dataOf(out);

    expect(data.deals_by_stage).toEqual([
      { stage_id: 'st-1', count: 2, amount: 200, stage_name: 'Переговоры' },
      // Стадии, которой уже нет в справочнике, имя не выдумываем — остаётся id.
      { stage_id: 'st-gone', count: 1, amount: 100 },
    ]);
    expect(data.orders_by_stage).toEqual([{ stage_id: 'st-2', count: 1, stage_name: 'Счёт' }]);
    // Цифры среза не тронуты.
    expect(data.totals).toEqual({ deals_count: 3 });
  });

  it('справочник стадий запрашивается по projectId маршрута и один раз на TTL', async () => {
    const { svc, listPipelines, outboundMeta } = makeService();

    await svc.enrichRunResult(REQ, RUN(SUMMARY) as Record<string, unknown>);
    await svc.enrichRunResult(REQ, RUN(SUMMARY) as Record<string, unknown>);

    expect(listPipelines).toHaveBeenCalledTimes(1);
    expect(listPipelines).toHaveBeenCalledWith({ project_id: 'p1' }, { md: true });
    expect(outboundMeta.build).toHaveBeenCalledWith(REQ, { projectId: 'p1' });
  });

  it('другой проект — свой справочник (кэш не протекает между проектами)', async () => {
    const { svc, listPipelines } = makeService();
    const reqP2 = {
      headers: { 'x-project-id': 'p2' },
      query: { projectId: 'p2' },
      user: { userId: 'u-1' },
    } as never;

    await svc.enrichRunResult(REQ, RUN(SUMMARY) as Record<string, unknown>);
    await svc.enrichRunResult(reqP2, RUN(SUMMARY) as Record<string, unknown>);

    expect(listPipelines).toHaveBeenCalledTimes(2);
    expect(listPipelines).toHaveBeenLastCalledWith({ project_id: 'p2' }, { md: true });
  });

  it('projectId берётся из маршрута, а не из тела запроса (граница проекта)', async () => {
    const { svc, listPipelines } = makeService();
    const req = {
      headers: { 'x-project-id': 'p1' },
      query: { projectId: 'p1' },
      body: { projectId: 'p-foreign' },
      user: { userId: 'u-1' },
    } as never;

    await svc.enrichRunResult(req, RUN(SUMMARY) as Record<string, unknown>);

    expect(listPipelines).toHaveBeenCalledWith({ project_id: 'p1' }, { md: true });
  });

  it('pipe недоступен → прогон возвращается без имён, цифры на месте (fail-soft)', async () => {
    const { svc } = makeService({ pipeFail: true });

    const out = await svc.enrichRunResult(REQ, RUN(SUMMARY) as Record<string, unknown>);
    const data = dataOf(out);

    expect(data.deals_by_stage).toEqual([
      { stage_id: 'st-1', count: 2, amount: 200 },
      { stage_id: 'st-gone', count: 1, amount: 100 },
    ]);
  });

  it('нет проектного контекста → RPC не дёргается, прогон отдаётся как есть', async () => {
    const { svc, listPipelines } = makeService();
    const req = { headers: {}, user: { userId: 'u-1' } } as never;

    const out = await svc.enrichRunResult(req, RUN(SUMMARY) as Record<string, unknown>);

    expect(listPipelines).not.toHaveBeenCalled();
    expect(dataOf(out).deals_by_stage).toEqual(SUMMARY.deals_by_stage);
  });

  it('пустые срезы → ни одного RPC (обогащение не стоит вызова pipe)', async () => {
    const { svc, listPipelines } = makeService();

    const out = await svc.enrichRunResult(
      REQ,
      RUN({ totals: { deals_count: 0 }, deals_by_stage: [], orders_by_stage: [] }) as Record<
        string,
        unknown
      >,
    );

    expect(listPipelines).not.toHaveBeenCalled();
    expect(dataOf(out).deals_by_stage).toEqual([]);
  });
});

describe('ReportRunNamesService — срезы пресетов (TODO-253)', () => {
  it('funnel_stages подписываются тем же справочником, что и общий срез', async () => {
    const { svc } = makeService();

    const out = await svc.enrichRunResult(
      REQ,
      RUN({
        preset_key: 'funnel',
        funnel_stages: [
          // Домен уже подписал стадию сам (pipe был доступен) — имя совпадает.
          { stage_id: 'st-1', stage_name: 'Переговоры', count: 2, conversion: 100 },
          // А здесь домен отдал фоллбек на id: имя приезжает от gateway.
          { stage_id: 'st-2', stage_name: 'st-2', count: 1, conversion: 50 },
        ],
      }) as Record<string, unknown>,
    );

    expect(
      (dataOf(out).funnel_stages as Record<string, unknown>[]).map((r) => r.stage_name),
    ).toEqual(['Переговоры', 'Счёт']);
  });

  it('activities_by_manager подписывается тем же справочником людей, что deals_by_manager', async () => {
    const { svc } = makeService();
    const identity = { resolveNames: jest.fn().mockResolvedValue(new Map([['u-7', 'Иванов А.']])) };
    // подменяем резолвер имён на экземпляре (конструктор его уже принял)
    (svc as unknown as { identity: unknown }).identity = identity;

    const out = await svc.enrichRunResult(
      REQ,
      RUN({
        preset_key: 'activity',
        activities_by_manager: [{ manager_id: 'u-7', count: 8, overdue: 3 }],
      }) as Record<string, unknown>,
    );

    expect(identity.resolveNames).toHaveBeenCalledWith(REQ, ['u-7']);
    expect(dataOf(out).activities_by_manager).toEqual([
      { manager_id: 'u-7', count: 8, overdue: 3, manager_name: 'Иванов А.' },
    ]);
  });
});

/**
 * TODO-478 (доля gateway) — сравнение с прошлым периодом в КАРТОЧКАХ прогона.
 *
 * На дашборде `previous_value`/`growth_rate` едут типизированными полями
 * `StatMetricValue` (см. statistics-bff.kpi-growth.spec.ts), а у прогона отчёта
 * карточки живут внутри `data_json` — единственного места, которое gateway
 * ПЕРЕПИСЫВАЕТ (разбор → подстановка имён → сериализация обратно). Значит,
 * любое поле, которое домен добавит в сводку (`*_previous`, `growth`), обязано
 * пережить это переписывание — иначе повторится ровно тот класс дефекта, ради
 * которого шла волна: «домен посчитал, а до пользователя не доехало».
 */
describe('ReportRunNamesService — обогащение не теряет полей сводки (TODO-478)', () => {
  it('незнакомые ключи data_json (в т.ч. сравнение с прошлым периодом) остаются на месте', async () => {
    const { svc } = makeService();

    const out = await svc.enrichRunResult(
      REQ,
      RUN({
        totals: { deals_count: 3, deals_amount: 150 },
        // То, что домену предстоит добавить для тренда карточек.
        totals_previous: { deals_count: 2, deals_amount: 100 },
        deals_by_stage: [{ stage_id: 'st-1', count: 2, amount: 200, growth: 0.5 }],
      }) as Record<string, unknown>,
    );
    const data = dataOf(out);

    expect(data.totals_previous).toEqual({ deals_count: 2, deals_amount: 100 });
    expect(data.deals_by_stage).toEqual([
      // Подпись стадии дописана, `growth` строки не потерян и не перезаписан.
      { stage_id: 'st-1', count: 2, amount: 200, growth: 0.5, stage_name: 'Переговоры' },
    ]);
  });

  it('конверт ответа домена сохраняется целиком (обогащение меняет только data_json)', async () => {
    const { svc } = makeService();

    const out = (await svc.enrichRunResult(REQ, {
      ...(RUN(SUMMARY) as Record<string, unknown>),
      preset_key: 'sales',
      summary: { totals: { deals_count: 3 } },
    })) as Record<string, unknown>;

    expect(out.report_id).toBe('r-1');
    expect(out.generated_at).toBe(1_700_000_000_000);
    expect(out.preset_key).toBe('sales');
    expect(out.summary).toEqual({ totals: { deals_count: 3 } });
  });
});

/** TODO-470: подписи источников в deals_by_source (пресет «По источникам»). */
describe('ReportRunNamesService — deals_by_source source_name', () => {
  it('дописывает source_name, source остаётся сырым ключом', async () => {
    const listDealSources = jest
      .fn()
      .mockReturnValue(of({ list: [{ id: 'src-1', name: 'Сайт' }] }));
    const listPipelines = jest.fn().mockReturnValue(of({ list: [] }));
    const controlClient = {
      getService: jest.fn().mockReturnValue({ listDepartments: jest.fn(() => of({ list: [] })) }),
    } as never;
    const pipeClient = {
      getService: jest.fn().mockReturnValue({ listPipelines, listDealSources }),
    } as never;
    const outboundMeta = { build: jest.fn(() => ({})) } as never;
    const identity = { resolveNames: jest.fn() } as never;
    const svc = new ReportRunNamesService(controlClient, pipeClient, outboundMeta, identity);
    svc.onModuleInit();

    const out = await svc.enrichRunResult(
      REQ,
      RUN({
        deals_by_source: [{ source: 'src-1', count: 4, amount: 400 }],
      }) as Record<string, unknown>,
    );
    const data = dataOf(out);
    expect(data.deals_by_source).toEqual([
      { source: 'src-1', count: 4, amount: 400, source_name: 'Сайт' },
    ]);
  });
});
