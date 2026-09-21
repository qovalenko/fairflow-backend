import { ReportsService } from './reports.service';
import type { VisibilityScope } from '@fairflow/shared';

/**
 * TODO-272 (FR-STAT-280/290): срез «Типы продаж» (`order_types`). Раньше вкладка
 * была только на фронте — домен такого среза не считал, а в GetMetricsResponse
 * не было даже поля, куда его положить: пользователь видел вечно пустой виджет
 * (класс дефектов «UI есть, бэка нет»).
 *
 * Здесь зафиксировано: срез считается по ЗАКАЗАМ (`crm_orders`), гейтится
 * модулем `orders` (а не `deals`), стартует с `$match` = проект + видимость
 * заказов + период (изоляция и ABAC пушатся в БД первой стадией), и отдаёт
 * ТОЛЬКО счётчик — у заказа нет собственной суммы, выдумывать amount нельзя.
 */
describe('ReportsService.getMetrics — срез order_types', () => {
  const SCOPE: VisibilityScope = {
    mode: 'restricted',
    level: 'only_own',
    selfId: 'u1',
    ownerIds: ['u1'],
    sharedRecordIds: [],
  };

  function makeService(rows: Record<string, unknown>[] | Error) {
    const ordersAggregate = jest.fn().mockReturnValue({
      toArray: jest.fn(() => (rows instanceof Error ? Promise.reject(rows) : Promise.resolve(rows))),
    });
    const dealsAggregate = jest.fn().mockReturnValue({ toArray: jest.fn().mockResolvedValue([]) });
    const mongo = {
      orders: () => ({ aggregate: ordersAggregate }),
      deals: () => ({ aggregate: dealsAggregate }),
      activities: () => ({ aggregate: dealsAggregate }),
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
    return { svc, ordersAggregate, dealsAggregate };
  }

  it('считает продажи по типам из crm_orders и отдаёт их в order_types', async () => {
    const { svc, ordersAggregate } = makeService([
      { _id: 't1', count: 4 },
      { _id: '', count: 1 },
    ]);

    const res = (await svc.getMetrics('p1', 'month', 0, 0, ['order_types'], SCOPE, [
      'statistics',
      'orders',
    ])) as { order_types: Array<Record<string, unknown>>; slices: string[] };

    expect(res.slices).toContain('order_types');
    expect(res.order_types).toEqual([
      { order_type_id: 't1', orders_count: 4 },
      // заказ без типа не выбрасывается и не подписывается фейком — пустой id.
      { order_type_id: '', orders_count: 1 },
    ]);
    // Суммы у заказа нет — в строке её и не появляется (никакого amount: 0).
    expect(res.order_types[0]).not.toHaveProperty('amount');
    expect(ordersAggregate).toHaveBeenCalledTimes(1);
  });

  it('$match среза стартует с проекта + видимости ЗАКАЗОВ + периода (изоляция и ABAC в БД)', async () => {
    const { svc, ordersAggregate } = makeService([]);

    await svc.getMetrics('p1', 'month', 0, 0, ['order_types'], SCOPE, ['orders']);

    const pipeline = ordersAggregate.mock.calls[0][0] as Array<Record<string, unknown>>;
    const match = pipeline[0].$match as { $and: Record<string, unknown>[] };
    // andMatch, не spread: все фрагменты с $or должны сохраниться.
    expect(match.$and).toHaveLength(4);
    expect(match.$and[0]).toEqual({ $or: [{ projectId: 'p1' }, { project_id: 'p1' }] });
    // OWNER_FIELD.orders = assigneeId — предикат СВОЕЙ сущности, не сделок.
    expect(match.$and[1]).toEqual({ assigneeId: { $in: ['u1'] } });
    // TODO-244: удалённые в корзину продажи в срез не попадают.
    expect(match.$and[2]).toEqual({ deletedAt: { $in: [null, undefined, 0] } });
    expect(Object.keys(match.$and[3])).toEqual(['$or']);
    // группировка — по типу заказа, обе раскладки имени поля.
    expect(pipeline[1].$group).toMatchObject({ _id: { $ifNull: ['$typeId', '$type_id', ''] } });
  });

  it('модуль orders выключен → среза нет вовсе (FR-MSTAT-17), заказы не читаются', async () => {
    const { svc, ordersAggregate } = makeService([{ _id: 't1', count: 4 }]);

    const res = (await svc.getMetrics('p1', 'month', 0, 0, [], SCOPE, ['statistics', 'deals'])) as {
      order_types: unknown[];
      slices: string[];
    };

    expect(res.slices).not.toContain('order_types');
    expect(res.order_types).toEqual([]);
    expect(ordersAggregate).not.toHaveBeenCalled();
  });

  it('падение источника не рушит экран: срез пустой, partial=true (fail-soft)', async () => {
    const { svc } = makeService(new Error('mongo down'));

    const res = (await svc.getMetrics('p1', 'month', 0, 0, ['order_types'], SCOPE, ['orders'])) as {
      order_types: unknown[];
      partial: boolean;
    };

    expect(res.order_types).toEqual([]);
    expect(res.partial).toBe(true);
  });

  it('без резолвнутого scope срез не отдаётся вовсе (fail-closed, FR-MSTAT-4)', async () => {
    const { svc } = makeService([{ _id: 't1', count: 4 }]);

    await expect(
      svc.getMetrics('p1', 'month', 0, 0, ['order_types'], undefined, ['orders']),
    ).rejects.toThrow();
  });
});
