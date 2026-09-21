import { ProductService } from './product.service';

describe('ProductService.list — no demo seed on read', () => {
  it('does not insert a demo product when the catalog is empty', async () => {
    const insertOne = jest.fn();
    const countDocuments = jest.fn().mockResolvedValue(0);
    const find = jest.fn().mockReturnValue({
      sort: () => ({
        skip: () => ({
          limit: () => ({
            toArray: async () => [],
          }),
        }),
      }),
    });
    const mongo = {
      products: () => ({ countDocuments, find, insertOne }),
    } as never;
    const outbox = { withOutbox: jest.fn() } as never;
    const svc = new ProductService(mongo, outbox);

    const res = await svc.list('p1', 0, 25);

    expect(res).toEqual({ list: [], total: 0 });
    expect(insertOne).not.toHaveBeenCalled();
  });
});
