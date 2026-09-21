import { of, throwError } from 'rxjs';
import { StatisticsBffController } from './statistics-bff.controller';
import type { GatewayOutboundMetadataService } from './gateway-outbound-metadata.service';
import type { IdentityResolverService } from './identity-resolver.service';

/**
 * В2 (волна разрывов «домен умеет, а до пользователя не доходит»): reports —
 * Mongo-домен, он группирует срезы по `owner_id` / `department_id` и справочников
 * людей (auth) и оргструктуры (control) не видит, а на StatisticsBffController не
 * был навешан НИ один резолв имён. В результате «Топ менеджеров» и «Продажи по
 * отделам» показывали пользователю сырые UUID.
 *
 * Здесь зафиксировано: строка статистики несёт ИМЯ, а не только id — и на экране
 * (`/api/v1/statistics`), и в выгрузке (`/api/v1/statistics/export`), при этом id
 * не теряется (по нему drill, FR-MSTAT-24), а недоступность справочника не рушит
 * срез (fail-soft) и не подменяет цифры.
 *
 * TODO-272: тем же контрактом закрыт срез «Типы продаж» (`order_types`) — reports
 * группирует заказы по `typeId`, название типа подставляет gateway из
 * `OrdersGrpc.ListOrderTypes`.
 */

const METRICS = {
  sales: [],
  funnel: [],
  sources: [],
  team: [
    // deals_count приходит int64 — в тесте отдаём его Long'ом {low,high}, чтобы
    // зафиксировать, что на выходе BFF это ЧИСЛО (грабля «loader без longs»).
    {
      owner_id: 'u1',
      deals_count: { low: 7, high: 0, unsigned: false },
      amount: 700,
      avg_check: 100,
      activities_count: 3,
    },
    { owner_id: 'u-unknown', deals_count: 1, amount: 10, avg_check: 10, activities_count: 0 },
  ],
  by_department: [
    { department_id: 'd1', deals_count: 5, amount: 500, avg_check: 100, managers_count: 2 },
    { department_id: '', deals_count: 1, amount: 10, avg_check: 10, managers_count: 1 },
  ],
  order_types: [
    // orders_count тоже int64 — Long'ом, чтобы зафиксировать число на выходе.
    { order_type_id: 't1', orders_count: { low: 4, high: 0, unsigned: false } },
    { order_type_id: 't-unknown', orders_count: 1 },
  ],
  stage_durations: [
    {
      stage_id: 'st1',
      label: 'Квалификация',
      transition_count: { low: 9, high: 0, unsigned: false },
      avg_duration_ms: 3_600_000,
    },
  ],
  as_of: 1_700_000_000_000,
  partial: false,
  scope_level: 'Вся организация',
  period: 'month',
  from: 1,
  to: 2,
  slices: ['team', 'by_department', 'order_types'],
};

const REQ = { headers: { 'x-project-id': 'p1' }, user: { userId: 'viewer-1' } } as never;

function makeController(opts?: {
  departmentsFail?: boolean;
  orderTypesFail?: boolean;
  names?: Map<string, string>;
  /** X2: акторы, которых control считает членами оргструктуры; остальным — отказ. */
  members?: string[];
}) {
  const reports = { getMetrics: jest.fn().mockReturnValue(of(METRICS)) };
  const listDepartments = jest.fn((payload: { actor_user_id?: string }) => {
    if (opts?.departmentsFail) return throwError(() => new Error('control down'));
    // Ровно то, что делает control: assertMember(actor) → PERMISSION_DENIED не-члену.
    if (opts?.members && !opts.members.includes(payload?.actor_user_id ?? '')) {
      return throwError(() => new Error('7 PERMISSION_DENIED: not a member'));
    }
    return of({ list: [{ id: 'd1', name: 'Отдел продаж, СПб' }] });
  });
  const organization = { listDepartments };
  const listOrderTypes = jest
    .fn()
    .mockReturnValue(
      opts?.orderTypesFail
        ? throwError(() => new Error('orders down'))
        : of({ list: [{ id: 't1', name: 'Поставка, срочная' }] }),
    );
  const orders = { listOrderTypes };

  const reportsClient = { getService: jest.fn().mockReturnValue(reports) } as never;
  const controlClient = { getService: jest.fn().mockReturnValue(organization) } as never;
  const ordersClient = { getService: jest.fn().mockReturnValue(orders) } as never;
  // Справочники стадий/источников (pipe) в этом наборе не нужны: срезы funnel и
  // sources здесь пустые, поэтому RPC не дёргается вовсе — см. resolveStageNames.
  const pipe = {
    listPipelines: jest.fn().mockReturnValue(of({ list: [] })),
    listDealSources: jest.fn().mockReturnValue(of({ list: [] })),
  };
  const pipeClient = { getService: jest.fn().mockReturnValue(pipe) } as never;
  const appendEvent = jest.fn().mockReturnValue(of({ id: 'ev-1' }));
  const auditClient = { getService: jest.fn().mockReturnValue({ appendEvent }) } as never;
  const outboundMeta = {
    build: jest.fn(() => ({ md: true })),
  } as unknown as GatewayOutboundMetadataService;
  const identity = {
    resolveNames: jest
      .fn()
      .mockResolvedValue(opts?.names ?? new Map([['u1', 'Иванов Иван Иванович']])),
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
  return { ctl, reports, listDepartments, listOrderTypes, identity, pipe, appendEvent };
}

describe('StatisticsBffController — display-имена в срезах (В2, FR-MSTAT-17/28, FR-STAT-280)', () => {
  it('GET /statistics: строка команды несёт ФИО, строка отдела — название', async () => {
    const { ctl, identity } = makeController();

    const res = (await ctl.statistics(REQ)) as {
      team: Array<Record<string, unknown>>;
      byDepartment: Array<Record<string, unknown>>;
    };

    expect(identity.resolveNames).toHaveBeenCalledWith(REQ, ['u1', 'u-unknown']);
    expect(res.team[0]).toMatchObject({
      ownerId: 'u1',
      // assigneeId/assigneeName — контракт, который фронт уже читает.
      assigneeId: 'u1',
      ownerName: 'Иванов Иван Иванович',
      assigneeName: 'Иванов Иван Иванович',
    });
    // int64-счётчик доезжает числом, а не объектом Long.
    expect(res.team[0].dealsCount).toBe(7);
    expect(res.byDepartment[0]).toMatchObject({
      departmentId: 'd1',
      departmentName: 'Отдел продаж, СПб',
      dealsCount: 5,
      managersCount: 2,
    });
  });

  it('неразрешённый id не подменяется фейком: имя пустое, id сохранён', async () => {
    const { ctl } = makeController();
    const res = (await ctl.statistics(REQ)) as {
      team: Array<Record<string, unknown>>;
      byDepartment: Array<Record<string, unknown>>;
    };

    expect(res.team[1]).toMatchObject({ ownerId: 'u-unknown', ownerName: '', assigneeName: '' });
    // сделки без отдела: id пустой → и имя пустое (фронт покажет «Без отдела»).
    expect(res.byDepartment[1]).toMatchObject({ departmentId: '', departmentName: '' });
  });

  it('справочник отделов недоступен → срез отдаётся с id и цифрами (fail-soft)', async () => {
    const { ctl } = makeController({ departmentsFail: true });

    const res = (await ctl.statistics(REQ)) as { byDepartment: Array<Record<string, unknown>> };

    expect(res.byDepartment[0]).toMatchObject({
      departmentId: 'd1',
      departmentName: '',
      dealsCount: 5,
      amount: 500,
    });
  });

  it('справочник отделов запрашивается у control один раз на TTL и без org из клиента', async () => {
    const { ctl, listDepartments } = makeController();

    await ctl.statistics(REQ);
    await ctl.statistics(REQ);

    expect(listDepartments).toHaveBeenCalledTimes(1);
    // DEORG-BE-16: org-якорь control резолвит сам, gateway шлёт только актора.
    expect(listDepartments).toHaveBeenCalledWith(
      { organization_id: '', actor_user_id: 'viewer-1' },
      expect.anything(),
    );
  });

  it('CSV-выгрузка несёт колонку label с ФИО и названием отдела (экранированную)', async () => {
    const { ctl } = makeController();
    const res = { header: jest.fn() } as never;

    const buf = (await ctl.export(REQ, res, undefined, 'csv')) as Buffer;
    const csv = buf.toString('utf8');

    expect(csv.split('\n')[0]).toBe('section,key,count,amount,label');
    expect(csv).toContain('team,u1,7,700,Иванов Иван Иванович');
    // запятая в названии отдела экранируется кавычками, а не рвёт строку.
    expect(csv).toContain('by_department,d1,5,500,"Отдел продаж, СПб"');
  });

  /**
   * X2 — кэш названий отделов был один на процесс. Единственная проверка доступа
   * к оргструктуре живёт в control (`assertMember` по актору), и попадание в
   * общий кэш её закорачивало: прогрел член — 30 секунд названия получал кто
   * угодно, кто дошёл до ручки. Ключ теперь включает актора.
   */
  describe('X2: кэш отделов не отдаёт чужое', () => {
    const MEMBER = REQ;
    const INTRUDER = {
      headers: { 'x-project-id': 'p1' },
      user: { userId: 'intruder-9' },
    } as never;

    it('не-член не получает названия из прогретого членом кэша', async () => {
      const { ctl, listDepartments } = makeController({ members: ['viewer-1'] });

      // член прогревает кэш и видит название
      const asMember = (await ctl.statistics(MEMBER)) as {
        byDepartment: Array<Record<string, unknown>>;
      };
      expect(asMember.byDepartment[0]).toMatchObject({ departmentName: 'Отдел продаж, СПб' });

      // не-член приходит внутрь TTL: его вопрос всё равно доходит до control…
      const asIntruder = (await ctl.statistics(INTRUDER)) as {
        byDepartment: Array<Record<string, unknown>>;
      };
      expect(listDepartments).toHaveBeenCalledTimes(2);
      expect(listDepartments).toHaveBeenLastCalledWith(
        { organization_id: '', actor_user_id: 'intruder-9' },
        expect.anything(),
      );
      // …и получает отказ: id остаётся, названия нет (fail-soft, не 500)
      expect(asIntruder.byDepartment[0]).toMatchObject({
        departmentId: 'd1',
        departmentName: '',
        dealsCount: 5,
      });
    });

    it('отказ не кэшируется: получив членство, актор увидит названия', async () => {
      const { ctl, listDepartments } = makeController({ members: ['viewer-1'] });

      const before = (await ctl.statistics(INTRUDER)) as {
        byDepartment: Array<Record<string, unknown>>;
      };
      expect(before.byDepartment[0]).toMatchObject({ departmentName: '' });

      // тот же актор, но control теперь считает его членом
      (listDepartments as jest.Mock).mockImplementation(() =>
        of({ list: [{ id: 'd1', name: 'Отдел продаж, СПб' }] }),
      );
      const after = (await ctl.statistics(INTRUDER)) as {
        byDepartment: Array<Record<string, unknown>>;
      };
      expect(after.byDepartment[0]).toMatchObject({ departmentName: 'Отдел продаж, СПб' });
      expect(listDepartments).toHaveBeenCalledTimes(2);
    });

    it('кэш остаётся кэшем: свой актор внутри TTL не ходит в control повторно', async () => {
      const { ctl, listDepartments } = makeController({ members: ['viewer-1'] });

      await ctl.statistics(MEMBER);
      await ctl.statistics(MEMBER);
      await ctl.statistics(MEMBER);

      expect(listDepartments).toHaveBeenCalledTimes(1);
    });
  });

  it('GET /statistics: stage_timing доезжает camelCase и числовым int64', async () => {
    const { ctl } = makeController();

    const res = (await ctl.statistics(REQ)) as {
      stageDurations: Array<Record<string, unknown>>;
    };

    expect(res.stageDurations[0]).toMatchObject({
      stageId: 'st1',
      label: 'Квалификация',
      transitionCount: 9,
      avgDurationMs: 3_600_000,
    });
    expect(res.stageDurations[0]).not.toHaveProperty('stage_id');
    expect(res.stageDurations[0]).not.toHaveProperty('transition_count');
  });

  it('GET /statistics: строка «Типы продаж» несёт название типа и числовой счётчик', async () => {
    const { ctl } = makeController();

    const res = (await ctl.statistics(REQ)) as { orderTypes: Array<Record<string, unknown>> };

    expect(res.orderTypes[0]).toMatchObject({
      // id сохранён — по нему drill/фильтр списка продаж (typeId), не по подписи.
      orderTypeId: 't1',
      orderTypeName: 'Поставка, срочная',
    });
    // int64 orders_count доезжает числом, а не объектом Long.
    expect(res.orderTypes[0].count).toBe(4);
    // неразрешённый id не подменяется фейком: имя пустое, цифра на месте.
    expect(res.orderTypes[1]).toMatchObject({
      orderTypeId: 't-unknown',
      orderTypeName: '',
      count: 1,
    });
  });

  it('справочник типов продаж недоступен → срез отдаётся с id и цифрами (fail-soft)', async () => {
    const { ctl } = makeController({ orderTypesFail: true });

    const res = (await ctl.statistics(REQ)) as { orderTypes: Array<Record<string, unknown>> };

    expect(res.orderTypes[0]).toMatchObject({ orderTypeId: 't1', orderTypeName: '', count: 4 });
  });

  it('справочник типов продаж запрашивается раз на TTL и включает удалённые типы', async () => {
    const { ctl, listOrderTypes } = makeController();

    await ctl.statistics(REQ);
    await ctl.statistics(REQ);

    expect(listOrderTypes).toHaveBeenCalledTimes(1);
    // Заказ живёт дольше своего типа: без include_deleted строка по удалённому
    // типу осталась бы с сырым id.
    expect(listOrderTypes).toHaveBeenCalledWith(
      { project_id: 'p1', include_deleted: true },
      expect.anything(),
    );
  });

  it('CSV-выгрузка несёт секцию order_types: счётчик есть, amount ПУСТОЙ (у заказа нет суммы)', async () => {
    const { ctl } = makeController();
    const res = { header: jest.fn() } as never;

    const buf = (await ctl.export(REQ, res, undefined, 'csv')) as Buffer;
    const csv = buf.toString('utf8');

    expect(csv).toContain('order_types,t1,4,,"Поставка, срочная"');
    // 0 в колонке amount читался бы как «продаж на 0 ₽» — этого быть не должно.
    expect(csv).not.toContain('order_types,t1,4,0,');
  });

  it('JSON-выгрузка несёт owner_name / department_name', async () => {
    const { ctl } = makeController();
    const res = { header: jest.fn() } as never;

    const buf = (await ctl.export(REQ, res, undefined, 'json')) as Buffer;
    const summary = JSON.parse(buf.toString('utf8')) as {
      team: Array<Record<string, unknown>>;
      byDepartment: Array<Record<string, unknown>>;
      orderTypes: Array<Record<string, unknown>>;
    };

    expect(summary.team[0]).toMatchObject({ owner_id: 'u1', owner_name: 'Иванов Иван Иванович' });
    expect(summary.byDepartment[0]).toMatchObject({
      department_id: 'd1',
      department_name: 'Отдел продаж, СПб',
    });
    expect(summary.orderTypes[0]).toMatchObject({
      order_type_id: 't1',
      order_type_name: 'Поставка, срочная',
    });
  });
});
