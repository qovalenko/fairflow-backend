import { ProjectPurgeConsumer } from './project-purge.consumer';

/** Smoke test for the company project-purge consumer (be-purged-consumers). */
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

describe('company ProjectPurgeConsumer', () => {
  it('drops companies + company_archives filtered by { projectId }', async () => {
    const { mongo, collections } = makeMongo();
    const c = new ProjectPurgeConsumer(mongo, { consume: jest.fn() } as never);
    expect(await c.handle(env('p1'))).toBe('purged');
    expect([...collections.keys()].sort()).toEqual(['companies', 'company_archives']);
    for (const coll of collections.values()) expect(coll.calls).toEqual([{ projectId: 'p1' }]);
  });

  it('poison message → dead_letter, nothing deleted', async () => {
    const { mongo, collections } = makeMongo();
    const c = new ProjectPurgeConsumer(mongo, { consume: jest.fn() } as never);
    expect(await c.handle(env(undefined))).toBe('dead_letter');
    expect(collections.size).toBe(0);
  });

  it('whitespace-only projectId → dead_letter', async () => {
    const { mongo, collections } = makeMongo();
    const c = new ProjectPurgeConsumer(mongo, { consume: jest.fn() } as never);
    expect(await c.handle(env('   '))).toBe('dead_letter');
    expect(collections.size).toBe(0);
  });

  it('does not bind RabbitMQ when disabled by env', async () => {
    const prev = process.env.PROJECT_PURGE_CONSUMERS_ENABLED;
    process.env.PROJECT_PURGE_CONSUMERS_ENABLED = 'false';
    try {
      const consume = jest.fn();
      const c = new ProjectPurgeConsumer({ getDb: jest.fn() } as never, { consume } as never);
      await c.onModuleInit();
      expect(consume).not.toHaveBeenCalled();
    } finally {
      if (prev === undefined) delete process.env.PROJECT_PURGE_CONSUMERS_ENABLED;
      else process.env.PROJECT_PURGE_CONSUMERS_ENABLED = prev;
    }
  });
});
