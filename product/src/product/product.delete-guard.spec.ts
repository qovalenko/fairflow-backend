import { ObjectId } from 'mongodb';
import { RpcException } from '@nestjs/microservices';
import { status } from '@grpc/grpc-js';
import { ProductService } from './product.service';
import type { CrossDomainCountService } from '../usage/cross-domain-count.service';

describe('ProductService.delete force-guard', () => {
  const projectId = 'p1';
  const productId = new ObjectId().toString();

  function makeService(opts: {
    advisory?: { dealsCount?: number; ordersCount?: number };
    cross?: { deals?: number | null; orders?: number | null };
    outboxImpl?: (fn: (session?: unknown) => Promise<unknown>) => Promise<unknown>;
  }) {
    const doc = {
      _id: new ObjectId(productId),
      projectId,
      status: 'active',
      dealsCount: opts.advisory?.dealsCount ?? 0,
      ordersCount: opts.advisory?.ordersCount ?? 0,
    };
    const findOne = jest.fn().mockResolvedValue(doc);
    const deleteOne = jest.fn().mockResolvedValue({ deletedCount: 1 });
    const products = () => ({ findOne, deleteOne, updateOne: jest.fn() });
    const mongo = { products } as never;
    const outbox = {
      withOutbox:
        opts.outboxImpl ??
        jest.fn(async (fn: (session?: unknown) => Promise<unknown>) => fn(undefined)),
    } as never;
    const crossCounts =
      opts.cross == null
        ? undefined
        : ({
            countDeals: jest
              .fn()
              .mockResolvedValue(
                opts.cross.deals == null
                  ? null
                  : { deals: opts.cross.deals, activeDeals: opts.cross.deals },
              ),
            countOrders: jest.fn().mockResolvedValue(opts.cross.orders ?? null),
          } as unknown as CrossDomainCountService);
    const svc = new ProductService(mongo, outbox, crossCounts);
    return { svc, findOne, deleteOne, outbox };
  }

  it('blocks force-delete when orders reference the product', async () => {
    const { svc } = makeService({
      advisory: { dealsCount: 0, ordersCount: 0 },
      cross: { deals: 2, orders: 1 },
    });
    try {
      await svc.delete(projectId, productId, true);
      throw new Error('expected RpcException');
    } catch (e) {
      expect(e).toBeInstanceOf(RpcException);
      const err = (e as RpcException).getError() as {
        code: number;
        details?: Record<string, unknown>;
      };
      expect(err.code).toBe(status.FAILED_PRECONDITION);
      expect(err.details).toEqual({ deals: 2, orders: 1 });
    }
  });

  it('allows force-delete when only deals reference the product (pipe clears on event)', async () => {
    const { svc, deleteOne } = makeService({
      advisory: { dealsCount: 0, ordersCount: 0 },
      cross: { deals: 2, orders: 0 },
    });
    const res = await svc.delete(projectId, productId, true);
    expect(res).toEqual({ ok: true });
    expect(deleteOne).toHaveBeenCalled();
  });
});
