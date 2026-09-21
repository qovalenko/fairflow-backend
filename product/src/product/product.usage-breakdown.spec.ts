/**
 * FR-PRODUCTS-230: `GetProductUsage` раскладывает связи продукта по
 * подразделениям и по людям — вместо двух пустых массивов, которые отдавались
 * раньше (карточка «где используется» показывала только скалярные счётчики).
 *
 * Проверяем: изоляция по проекту/продукту, склейка сделок и продаж в одну строку,
 * сужение по department_id и PII-гейт пофамильного среза.
 */
import { ObjectId } from 'mongodb';
import type { VisibilityScope } from '@fairflow/shared';
import { ProductService } from './product.service';

type Doc = Record<string, unknown>;

const PRODUCT_ID = new ObjectId();

function scope(mode: 'all' | 'restricted'): VisibilityScope {
  return {
    mode,
    level: mode === 'all' ? 'all' : 'only_own',
    selfId: 'u1',
    ownerIds: ['u1'],
    sharedRecordIds: [],
  } as VisibilityScope;
}

function makeService(
  deals: Doc[] = [],
  orders: Doc[] = [],
): { svc: ProductService; matches: { deals: Doc[]; orders: Doc[] } } {
  const matches: { deals: Doc[]; orders: Doc[] } = { deals: [], orders: [] };

  /** Крошечная замена $group/$ifNull: тест проверяет контракт среза, не Mongo. */
  const aggregate = (rows: Doc[], sink: Doc[]) => (pipeline: Doc[]) => {
    const match = (pipeline[0] as { $match: Doc }).$match;
    sink.push(match);
    const groupId = (pipeline[1] as { $group: { _id: Doc } }).$group._id;
    const path = JSON.stringify(groupId).includes('departmentId') ? 'departmentId' : 'owner';
    const counts = new Map<string, number>();
    for (const r of rows) {
      const key =
        path === 'departmentId'
          ? String(r.departmentId ?? '')
          : String(r.assigneeId ?? r.ownerId ?? '');
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    return { toArray: async () => [...counts].map(([_id, count]) => ({ _id, count })) };
  };

  const mongo = {
    products: () => ({
      findOne: async () => ({
        _id: PRODUCT_ID,
        projectId: 'p1',
        name: 'Тариф',
        dealsCount: deals.length,
        activeDealsCount: deals.length,
        ordersCount: orders.length,
      }),
    }),
    deals: () => ({ aggregate: aggregate(deals, matches.deals) }),
    orders: () => ({ aggregate: aggregate(orders, matches.orders) }),
  } as never;
  const outbox = { withOutbox: jest.fn() } as never;
  return { svc: new ProductService(mongo, outbox), matches };
}

describe('ProductService.usage — срезы by_department / by_user', () => {
  const deals = [
    { departmentId: 'dept-1', assigneeId: 'u1' },
    { departmentId: 'dept-1', assigneeId: 'u2' },
    { departmentId: 'dept-2', assigneeId: 'u2' },
  ];
  const orders = [{ departmentId: 'dept-1', assigneeId: 'u1' }, { assigneeId: 'u3' }];

  it('складывает сделки и продажи в одну строку подразделения', async () => {
    const { svc } = makeService(deals, orders);

    const res = await svc.usage('p1', PRODUCT_ID.toString(), '', scope('all'));

    expect(res.by_department).toContainEqual({ department_id: 'dept-1', deals: 2, orders: 1 });
    expect(res.by_department).toContainEqual({ department_id: 'dept-2', deals: 1, orders: 0 });
    // Продажа без подразделения не выдумывает его — она в «пустой» строке.
    expect(res.by_department).toContainEqual({ department_id: '', deals: 0, orders: 1 });
  });

  it('пофамильный срез склеивает сделки и продажи по владельцу', async () => {
    const { svc } = makeService(deals, orders);

    const res = await svc.usage('p1', PRODUCT_ID.toString(), '', scope('all'));

    expect(res.by_user).toContainEqual({ user_id: 'u1', deals: 1, orders: 1 });
    expect(res.by_user).toContainEqual({ user_id: 'u2', deals: 2, orders: 0 });
    expect(res.by_user).toContainEqual({ user_id: 'u3', deals: 0, orders: 1 });
  });

  it('PII-гейт: без полной видимости пофамильного среза нет, агрегаты остаются', async () => {
    const { svc } = makeService(deals, orders);

    const res = await svc.usage('p1', PRODUCT_ID.toString(), '', scope('restricted'));

    expect(res.by_user).toEqual([]);
    expect(res.by_department.length).toBeGreaterThan(0);
  });

  it('изоляция: $match начинается с projectId и productId, мягко удалённые не в счёт', async () => {
    const { svc, matches } = makeService(deals, orders);

    await svc.usage('p1', PRODUCT_ID.toString(), '', scope('all'));

    expect(matches.deals[0]).toMatchObject({
      projectId: 'p1',
      productId: PRODUCT_ID.toString(),
      deletedAt: { $in: [null, undefined] },
    });
    expect(matches.orders[0]).toMatchObject({
      projectId: 'p1',
      productId: PRODUCT_ID.toString(),
      status: { $ne: 'CANCELLED' },
    });
  });

  it('department_id сужает срез до одного подразделения', async () => {
    const { svc, matches } = makeService(deals, orders);

    await svc.usage('p1', PRODUCT_ID.toString(), 'dept-1', scope('all'));

    expect(matches.deals[0]).toMatchObject({ departmentId: 'dept-1' });
    expect(matches.orders[0]).toMatchObject({ departmentId: 'dept-1' });
  });

  it('скалярные счётчики карточки остаются прежними', async () => {
    const { svc } = makeService(deals, orders);

    const res = await svc.usage('p1', PRODUCT_ID.toString(), '', scope('all'));

    expect(res).toMatchObject({ deals_count: 3, active_deals_count: 3, orders_count: 2 });
  });
});
