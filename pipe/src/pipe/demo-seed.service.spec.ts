import { DemoSeedService } from './demo-seed.service';

function makeFakeDb() {
  const touched = new Map<string, number>();
  const collection = (name: string) => ({
    findOne: jest.fn(async (filter: Record<string, unknown>) => {
      if (name === 'crm_pipelines' && filter.isDefault) return null;
      return null;
    }),
    updateOne: jest.fn(async () => {
      touched.set(name, (touched.get(name) ?? 0) + 1);
      return { upsertedCount: 1 };
    }),
  });
  return {
    db: { collection },
    touched,
  };
}

describe('DemoSeedService.seed', () => {
  it('requires projectId and ownerId', async () => {
    const svc = new DemoSeedService({ getDb: () => makeFakeDb().db } as never);
    await expect(svc.seed({ projectId: ' ', ownerId: 'u1', enabledModules: [] })).rejects.toThrow(
      'demo-seed: projectId and ownerId are required',
    );
    await expect(svc.seed({ projectId: 'p1', ownerId: '', enabledModules: [] })).rejects.toThrow(
      'demo-seed: projectId and ownerId are required',
    );
  });

  it('always seeds deals infrastructure but skips optional modules when disabled', async () => {
    const { db, touched } = makeFakeDb();
    const svc = new DemoSeedService({ getDb: () => db } as never);
    const result = await svc.seed({
      projectId: 'p-demo',
      ownerId: 'owner-1',
      enabledModules: [],
    });
    expect(result).toMatchObject({
      seeded: true,
      companies: 0,
      contacts: 0,
      products: 0,
      orders: 0,
      activities: 0,
    });
    expect(result.deals).toBeGreaterThan(0);
    expect(touched.has('crm_pipelines')).toBe(true);
    expect(touched.has('crm_deals')).toBe(true);
    expect(touched.has('companies')).toBe(false);
    expect(touched.has('contacts')).toBe(false);
    expect(touched.has('crm_products')).toBe(false);
  });

  it('seeds optional CRM modules when they are enabled', async () => {
    const { db, touched } = makeFakeDb();
    const svc = new DemoSeedService({ getDb: () => db } as never);
    const result = await svc.seed({
      projectId: 'p-full',
      ownerId: 'owner-1',
      enabledModules: ['companies', 'contacts', 'products', 'orders', 'activities'],
    });
    expect(result.companies).toBeGreaterThan(0);
    expect(result.contacts).toBeGreaterThan(0);
    expect(result.products).toBeGreaterThan(0);
    expect(result.orders).toBeGreaterThan(0);
    expect(result.activities).toBeGreaterThan(0);
    expect(touched.has('companies')).toBe(true);
    expect(touched.has('contacts')).toBe(true);
    expect(touched.has('crm_products')).toBe(true);
    expect(touched.has('crm_orders')).toBe(true);
    expect(touched.has('crm_activities')).toBe(true);
  });

  it('uses deterministic ids so repeated seed calls upsert the same documents', async () => {
    const { db } = makeFakeDb();
    const svc = new DemoSeedService({ getDb: () => db } as never);
    const first = await svc.seed({
      projectId: 'p-idem',
      ownerId: 'owner-1',
      enabledModules: [],
    });
    const second = await svc.seed({
      projectId: 'p-idem',
      ownerId: 'owner-1',
      enabledModules: [],
    });
    expect(second.deals).toBe(first.deals);
  });
});
