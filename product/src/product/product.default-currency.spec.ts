import { ObjectId } from 'mongodb';
import { RpcException } from '@nestjs/microservices';
import { ProductService } from './product.service';
import { ProjectModuleSettingsService } from '../control/project-module-settings.service';

describe('ProductService — defaultCurrency (FR-PRODUCTS-050)', () => {
  const makeMongo = () => {
    const insertOne = jest.fn().mockResolvedValue({ insertedId: new ObjectId() });
    return {
      products: () => ({ insertOne, countDocuments: jest.fn() }),
      insertOne,
    };
  };

  const makeOutbox = () =>
    ({
      withOutbox: async <R>(work: (s: undefined) => Promise<{ result: R; intents: unknown[] }>) => {
        const { result } = await work(undefined);
        return result;
      },
    }) as never;

  it('uses project integrationSettings.defaultCurrency when currency is omitted', async () => {
    const mongo = makeMongo();
    const moduleSettings = {
      defaultCurrency: jest.fn().mockResolvedValue('USD'),
    } as unknown as ProjectModuleSettingsService;
    const svc = new ProductService(mongo as never, makeOutbox(), undefined, moduleSettings);

    await svc.create('p1', { name: 'Plan A', price: 100, unit: 'ONE_TIME' });

    expect(moduleSettings.defaultCurrency).toHaveBeenCalledWith('p1');
    expect(mongo.insertOne).toHaveBeenCalledWith(
      expect.objectContaining({ currency: 'USD' }),
      expect.anything(),
    );
  });

  it('accepts explicit payload.currency when it matches the project default', async () => {
    const mongo = makeMongo();
    const moduleSettings = {
      defaultCurrency: jest.fn().mockResolvedValue('USD'),
    } as unknown as ProjectModuleSettingsService;
    const svc = new ProductService(mongo as never, makeOutbox(), undefined, moduleSettings);

    await svc.create('p1', { name: 'Plan B', price: 50, unit: 'ONE_TIME', currency: 'USD' });

    expect(mongo.insertOne).toHaveBeenCalledWith(
      expect.objectContaining({ currency: 'USD' }),
      expect.anything(),
    );
  });

  it('rejects explicit payload.currency that differs from the project default', async () => {
    const mongo = makeMongo();
    const moduleSettings = {
      defaultCurrency: jest.fn().mockResolvedValue('USD'),
    } as unknown as ProjectModuleSettingsService;
    const svc = new ProductService(mongo as never, makeOutbox(), undefined, moduleSettings);

    await expect(
      svc.create('p1', { name: 'Plan B', price: 50, unit: 'ONE_TIME', currency: 'EUR' }),
    ).rejects.toBeInstanceOf(RpcException);

    try {
      await svc.create('p1', { name: 'Plan B', price: 50, unit: 'ONE_TIME', currency: 'EUR' });
    } catch (e) {
      const err = (e as RpcException).getError() as { message?: string };
      expect(String(err.message)).toContain('CURRENCY_PROJECT_MISMATCH');
    }
    expect(mongo.insertOne).not.toHaveBeenCalled();
  });
});
