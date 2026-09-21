import { ProjectPurgeConsumer } from './project-purge.consumer';

/** Smoke test for the pipe project-purge consumer (be-purged-consumers). */
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

describe('pipe ProjectPurgeConsumer', () => {
  it('drops the pipe collections filtered by { projectId }', async () => {
    const { mongo, collections } = makeMongo();
    const c = new ProjectPurgeConsumer(mongo, { consume: jest.fn() } as never);
    expect(await c.handle(env('p1'))).toBe('purged');
    expect([...collections.keys()].sort()).toEqual(
      [
        'crm_deal_sources',
        'crm_deal_stage_history',
        'crm_deals',
        'crm_lost_reasons',
        'crm_pipelines',
      ].sort(),
    );
    for (const coll of collections.values()) expect(coll.calls).toEqual([{ projectId: 'p1' }]);
  });

  it('poison message → dead_letter, nothing deleted', async () => {
    const { mongo, collections } = makeMongo();
    const c = new ProjectPurgeConsumer(mongo, { consume: jest.fn() } as never);
    expect(await c.handle(env(undefined))).toBe('dead_letter');
    expect(collections.size).toBe(0);
  });
});
