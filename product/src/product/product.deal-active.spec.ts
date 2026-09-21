/**
 * FR-PRODUCTS-210 — applyDealActiveChange adjusts activeDealsCount only.
 */
import { ObjectId } from 'mongodb';
import { ProductService } from './product.service';

describe('ProductService.applyDealActiveChange (FR-PRODUCTS-210)', () => {
  const usageProcessed = {
    insertOne: jest.fn(async () => ({ insertedId: 'x' })),
  };
  const products = {
    updateOne: jest.fn(async () => ({ matchedCount: 1 })),
    findOne: jest.fn(async () => ({ activeDealsCount: 2 })),
  };
  const mongo = {
    usageProcessed: () => usageProcessed,
    products: () => products,
  };
  const svc = new ProductService(mongo as never, {} as never, undefined);

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('decrements activeDealsCount on close facts with dedup', async () => {
    await svc.applyDealActiveChange('proj1', new ObjectId().toString(), -1, 'dk-1', 'crm.deal.won');
    expect(products.updateOne).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: 'proj1' }),
      expect.objectContaining({ $inc: { activeDealsCount: -1 } }),
    );
  });

  it('skips duplicate dedup keys', async () => {
    usageProcessed.insertOne.mockRejectedValueOnce({ code: 11000 });
    await svc.applyDealActiveChange(
      'proj1',
      new ObjectId().toString(),
      -1,
      'dk-dup',
      'crm.deal.lost',
    );
    expect(products.updateOne).not.toHaveBeenCalled();
  });
});
