import { ProjectPurgeConsumer } from './project-purge.consumer';

/** Smoke test for the product project-purge consumer (be-purged-consumers). */
class FakeCollection {
  readonly calls: Record<string, unknown>[] = [];
  async deleteMany(filter: Record<string, unknown>) {
    this.calls.push(filter);
    return { deletedCount: 0 };
  }
}

function makeMongo() {
  const collections = new Map<string, FakeCollection>();
  const db = {
    collection(name: string) {
      if (!collections.has(name)) collections.set(name, new FakeCollection());
      return collections.get(name)!;
    },
  };
  return { mongo: { getDb: () => db } as never, collections };
}

const env = (projectId?: string) => ({ projectId, payload: {} }) as Record<string, unknown>;

describe('product ProjectPurgeConsumer', () => {
  it('drops crm_products + the usage dedup ledger filtered by { projectId }', async () => {
    const { mongo, collections } = makeMongo();
    const c = new ProjectPurgeConsumer(mongo, { consume: jest.fn() } as never);
    expect(await c.handle(env('p1'))).toBe('purged');
    expect([...collections.keys()].sort()).toEqual(['crm_product_usage_processed', 'crm_products']);
    for (const coll of collections.values()) expect(coll.calls).toEqual([{ projectId: 'p1' }]);
  });

  it('poison message → dead_letter, nothing deleted', async () => {
    const { mongo, collections } = makeMongo();
    const c = new ProjectPurgeConsumer(mongo, { consume: jest.fn() } as never);
    expect(await c.handle(env(undefined))).toBe('dead_letter');
    expect(collections.size).toBe(0);
  });
});
