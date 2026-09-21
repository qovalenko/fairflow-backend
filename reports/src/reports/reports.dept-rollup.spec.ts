import { ReportsService } from './reports.service';
import type { VisibilityScope } from '@fairflow/shared';

/**
 * FR-STAT-360: свёртка среза «команда» в подразделения.
 *
 * Наблюдателю уровня региона/топа видно тысячи владельцев: пофамильный список
 * такого размера не читается человеком и стоит линейно по размеру организации.
 * За порогом N_OWNER (1000 видимых владельцев) домен группирует ТУ ЖЕ выборку по
 * departmentId. `$match` при этом не меняется — видимость, ABAC и период
 * остаются прежними, меняется только ключ `$group`.
 */
describe('ReportsService.getMetrics — свёртка team в подразделения (FR-STAT-360)', () => {
  function scopeWithOwners(n: number): VisibilityScope {
    return {
      mode: 'restricted',
      level: 'custom',
      selfId: 'u1',
      ownerIds: Array.from({ length: n }, (_, i) => `u${i + 1}`),
      sharedRecordIds: [],
    } as VisibilityScope;
  }

  function makeService(dealRows: Record<string, unknown>[], actRows: Record<string, unknown>[] = []) {
    const dealsAggregate = jest
      .fn()
      .mockReturnValue({ toArray: jest.fn().mockResolvedValue(dealRows) });
    const activitiesAggregate = jest
      .fn()
      .mockReturnValue({ toArray: jest.fn().mockResolvedValue(actRows) });
    const mongo = {
      deals: () => ({ aggregate: dealsAggregate }),
      activities: () => ({ aggregate: activitiesAggregate }),
      orders: () => ({ aggregate: jest.fn().mockReturnValue({ toArray: async () => [] }) }),
    } as never;
    const svc = new ReportsService(
      mongo,
      {} as never,
      {} as never,
      {} as never,
      { read: async () => [] } as never,
      { get: async () => null, isTrusted: () => false } as never,
      { listForDeal: async () => [], avgDurationByStage: async () => [] } as never,
    );
    return { svc, dealsAggregate, activitiesAggregate };
  }

  const modules = ['statistics', 'deals', 'activities'];

  /** `andMatch` вкладывает базовый фильтр в период — разворачиваем в плоский список. */
  function flatten(node: unknown): Record<string, unknown>[] {
    if (!node || typeof node !== 'object') return [];
    const and = (node as { $and?: unknown[] }).$and;
    if (!Array.isArray(and)) return [node as Record<string, unknown>];
    return and.flatMap((n) => flatten(n));
  }

  it('под порогом срез остаётся пофамильным', async () => {
    const { svc, dealsAggregate } = makeService([{ _id: 'u7', count: 2, amount: 200 }]);

    const res = (await svc.getMetrics('p1', 'month', 0, 0, ['team'], scopeWithOwners(1000), modules)) as {
      team: Array<Record<string, unknown>>;
      team_grouping: string;
    };

    expect(res.team_grouping).toBe('user');
    expect(res.team[0]).toMatchObject({ owner_id: 'u7', department_id: '', deals_count: 2 });
    const pipeline = dealsAggregate.mock.calls[0][0] as Array<Record<string, unknown>>;
    expect(pipeline[1].$group).toMatchObject({ _id: { $ifNull: ['$assigneeId', '$ownerId'] } });
  });

  it('за порогом группировка идёт по departmentId', async () => {
    const { svc, dealsAggregate } = makeService([{ _id: 'dept-1', count: 40, amount: 4000 }]);

    const res = (await svc.getMetrics('p1', 'month', 0, 0, ['team'], scopeWithOwners(1001), modules)) as {
      team: Array<Record<string, unknown>>;
      team_grouping: string;
    };

    expect(res.team_grouping).toBe('department');
    const pipeline = dealsAggregate.mock.calls[0][0] as Array<Record<string, unknown>>;
    expect(pipeline[1].$group).toMatchObject({
      _id: { $ifNull: ['$departmentId', '$department_id', ''] },
    });
    // Свёрнутая строка — не человек: id подразделения не подсовывается в owner_id.
    expect(res.team[0]).toMatchObject({
      owner_id: '',
      department_id: 'dept-1',
      deals_count: 40,
      amount: 4000,
      avg_check: 100,
    });
  });

  it('за порогом активности считаются тем же ключом, что и сделки', async () => {
    const { svc, activitiesAggregate } = makeService(
      [{ _id: 'dept-1', count: 4, amount: 400 }],
      [{ _id: 'dept-1', count: 9 }],
    );

    const res = (await svc.getMetrics('p1', 'month', 0, 0, ['team'], scopeWithOwners(5000), modules)) as {
      team: Array<Record<string, unknown>>;
    };

    const pipeline = activitiesAggregate.mock.calls[0][0] as Array<Record<string, unknown>>;
    expect(pipeline[1].$group).toMatchObject({
      _id: { $ifNull: ['$departmentId', '$department_id', ''] },
    });
    expect(res.team[0]).toMatchObject({ department_id: 'dept-1', activities_count: 9 });
  });

  it('свёртка меняет только ключ группировки — изоляция и видимость в $match остаются', async () => {
    const under = makeService([]);
    await under.svc.getMetrics('p1', 'month', 0, 0, ['team'], scopeWithOwners(10), modules);
    const matchUnder = (under.dealsAggregate.mock.calls[0][0] as Record<string, unknown>[])[0]
      .$match as { $and: Record<string, unknown>[] };

    const over = makeService([]);
    await over.svc.getMetrics('p1', 'month', 0, 0, ['team'], scopeWithOwners(1001), modules);
    const matchOver = (over.dealsAggregate.mock.calls[0][0] as Record<string, unknown>[])[0]
      .$match as { $and: Record<string, unknown>[] };

    // Те же фрагменты в том же порядке: проект → видимость → не удалённые → период.
    expect(matchOver.$and).toHaveLength(matchUnder.$and.length);
    expect(flatten(matchOver)[0]).toEqual(flatten(matchUnder)[0]);
    expect(flatten(matchOver)[0]).toEqual({ $or: [{ projectId: 'p1' }, { project_id: 'p1' }] });
    // Видимость никуда не делась: сузили по 1001 владельцу, а не «показали всё».
    expect(flatten(matchOver)[1]).toMatchObject({
      assigneeId: { $in: expect.arrayContaining(['u1']) },
    });
  });
});
