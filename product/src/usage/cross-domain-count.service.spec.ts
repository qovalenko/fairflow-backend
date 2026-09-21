import { of, throwError } from 'rxjs';
import { CrossDomainCountService } from './cross-domain-count.service';

function makeService(opts: {
  deals?: { count?: number; active_count?: number } | 'error';
  orders?: { count?: number } | 'error';
} = {}) {
  const countDealsByProduct = jest.fn(() => {
    if (opts.deals === 'error') return throwError(() => new Error('pipe down'));
    return of(opts.deals ?? { count: 3, active_count: 2 });
  });
  const countOrdersByProduct = jest.fn(() => {
    if (opts.orders === 'error') return throwError(() => new Error('orders down'));
    return of(opts.orders ?? { count: 5 });
  });
  const pipeClient = { getService: jest.fn(() => ({ countDealsByProduct })) };
  const ordersClient = { getService: jest.fn(() => ({ countOrdersByProduct })) };
  const svc = new CrossDomainCountService(pipeClient as never, ordersClient as never);
  svc.onModuleInit();
  return { svc, countDealsByProduct, countOrdersByProduct };
}

describe('CrossDomainCountService', () => {
  it('countDeals returns pipe counts scoped to project/product', async () => {
    const { svc, countDealsByProduct } = makeService({ deals: { count: 4, active_count: 1 } });
    await expect(svc.countDeals('p1', 'prod-1')).resolves.toEqual({ deals: 4, activeDeals: 1 });
    expect(countDealsByProduct).toHaveBeenCalledWith(
      { project_id: 'p1', product_id: 'prod-1' },
      expect.anything(),
    );
  });

  it('countDeals returns null on RPC failure (best-effort)', async () => {
    const { svc } = makeService({ deals: 'error' });
    await expect(svc.countDeals('p1', 'prod-1')).resolves.toBeNull();
  });

  it('countOrders returns the orders count', async () => {
    const { svc, countOrdersByProduct } = makeService({ orders: { count: 9 } });
    await expect(svc.countOrders('p1', 'prod-2')).resolves.toBe(9);
    expect(countOrdersByProduct).toHaveBeenCalledWith(
      { project_id: 'p1', product_id: 'prod-2' },
      expect.anything(),
    );
  });

  it('countOrders returns null on RPC failure (best-effort)', async () => {
    const { svc } = makeService({ orders: 'error' });
    await expect(svc.countOrders('p1', 'prod-2')).resolves.toBeNull();
  });
});
