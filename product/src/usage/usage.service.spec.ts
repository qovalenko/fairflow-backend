/**
 * TODO-229 — сверка счётчиков продукта (RecountProductUsage) не должна обнулять
 * то, чего она не знает.
 *
 * Было: пропуск стоял только когда молчали ОБА источника
 * (`if (deals == null && orders == null) continue;`), а дальше шла безусловная
 * запись `deals: deals?.deals ?? 0, orders: orders ?? 0`. Значит лежащий pipe
 * обнулял продукту dealsCount/activeDealsCount, а лежащий orders — ordersCount:
 * транзиентный сбой RPC превращался в потерю данных в каталоге.
 *
 * Стало: в $set уходят только счётчики ответивших источников, продукт считается
 * сверенным (`recounted`) лишь при полном успехе, остальное — `skipped`.
 */
import { UsageService } from './usage.service';

function makeService(opts: {
  deals?: { deals: number; activeDeals: number } | null;
  orders?: number | null;
}) {
  const counts = {
    countDeals: jest.fn(async () => opts.deals ?? null),
    countOrders: jest.fn(async () => (opts.orders === undefined ? null : opts.orders)),
  };
  const product = {
    listProductIds: jest.fn(async () => ['p-1']),
    recountUsage: jest.fn(
      async (
        _projectId: string,
        _productId: string,
        _counts: { deals?: number; activeDeals?: number; orders?: number },
      ) => undefined,
    ),
  };
  const svc = new UsageService(counts as never, product as never);
  return { svc, counts, product };
}

describe('UsageService.recount — частичная сверка', () => {
  it('pipe лежит: ordersCount пишется, счётчики сделок НЕ затираются нулями', async () => {
    const { svc, product } = makeService({ deals: null, orders: 7 });

    const res = await svc.recount('proj1', 'prod1');

    expect(product.recountUsage).toHaveBeenCalledTimes(1);
    const counts = product.recountUsage.mock.calls[0][2] as Record<string, unknown>;
    expect(counts).toEqual({ orders: 7 });
    // Ключей deals/activeDeals нет вовсе — «не знаю», а не «ноль».
    expect(counts).not.toHaveProperty('deals');
    expect(counts).not.toHaveProperty('activeDeals');
    // Сверка неполная — продукт уходит в skipped, а не в recounted.
    expect(res).toEqual({ recounted: 0, skipped: 1 });
  });

  it('orders лежит: счётчики сделок пишутся, ordersCount НЕ затирается нулём', async () => {
    const { svc, product } = makeService({ deals: { deals: 4, activeDeals: 2 }, orders: null });

    const res = await svc.recount('proj1', 'prod1');

    expect(product.recountUsage.mock.calls[0][2]).toEqual({ deals: 4, activeDeals: 2 });
    expect(res).toEqual({ recounted: 0, skipped: 1 });
  });

  it('оба источника молчат: документ не трогаем вовсе', async () => {
    const { svc, product } = makeService({ deals: null, orders: null });

    const res = await svc.recount('proj1', 'prod1');

    expect(product.recountUsage).not.toHaveBeenCalled();
    expect(res).toEqual({ recounted: 0, skipped: 1 });
  });

  it('оба ответили: пишем все три счётчика, продукт сверен полностью', async () => {
    const { svc, product } = makeService({ deals: { deals: 4, activeDeals: 2 }, orders: 7 });

    const res = await svc.recount('proj1', 'prod1');

    expect(product.recountUsage.mock.calls[0][2]).toEqual({ deals: 4, activeDeals: 2, orders: 7 });
    expect(res).toEqual({ recounted: 1, skipped: 0 });
  });

  it('ноль — это ноль: настоящий нулевой ответ источника записывается', async () => {
    const { svc, product } = makeService({ deals: { deals: 0, activeDeals: 0 }, orders: 0 });

    await svc.recount('proj1', 'prod1');

    expect(product.recountUsage.mock.calls[0][2]).toEqual({ deals: 0, activeDeals: 0, orders: 0 });
  });

  it('бэкфилл без id идёт по всем продуктам проекта', async () => {
    const { svc, product } = makeService({ deals: { deals: 1, activeDeals: 1 }, orders: 1 });
    product.listProductIds.mockResolvedValueOnce(['a', 'b']);

    const res = await svc.recount('proj1');

    expect(product.recountUsage).toHaveBeenCalledTimes(2);
    expect(res).toEqual({ recounted: 2, skipped: 0 });
  });
});
