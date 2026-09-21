import { IdempotencyService } from './idempotency.service';

describe('IdempotencyService', () => {
  it('delegates to shared withIdempotency with the mongo collection', async () => {
    const collection = {
      insertOne: jest.fn().mockResolvedValue({ insertedId: 'x' }),
      findOne: jest.fn().mockResolvedValue(null),
      updateOne: jest.fn().mockResolvedValue({ modifiedCount: 1 }),
      deleteOne: jest.fn().mockResolvedValue({ deletedCount: 0 }),
    };
    const mongo = { idempotencyKeys: jest.fn().mockResolvedValue(collection) };
    const svc = new IdempotencyService(mongo as never);
    const executor = jest.fn().mockResolvedValue({ id: 'co1' });

    const result = await svc.withIdempotency(
      'p1',
      'idem-1',
      'create',
      executor,
      (r: { id: string }) => r.id,
    );

    expect(mongo.idempotencyKeys).toHaveBeenCalled();
    expect(collection.insertOne).toHaveBeenCalled();
    expect(executor).toHaveBeenCalled();
    expect(result).toEqual({ id: 'co1' });
  });

  it('runs executor once when key is empty (no dedup)', async () => {
    const collection = {
      insertOne: jest.fn(),
      findOne: jest.fn(),
      updateOne: jest.fn(),
      deleteOne: jest.fn(),
    };
    const mongo = { idempotencyKeys: jest.fn().mockResolvedValue(collection) };
    const svc = new IdempotencyService(mongo as never);
    const executor = jest.fn().mockResolvedValue('ok');

    await svc.withIdempotency('p1', undefined, 'create', executor);
    await svc.withIdempotency('p1', '   ', 'create', executor);

    expect(executor).toHaveBeenCalledTimes(2);
    expect(collection.insertOne).not.toHaveBeenCalled();
  });
});
