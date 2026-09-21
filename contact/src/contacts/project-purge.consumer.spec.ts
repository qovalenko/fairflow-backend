import { ProjectPurgeConsumer } from './project-purge.consumer';

/**
 * Unit tests for the contact project-purge consumer (be-purged-consumers).
 * The RabbitMQ transport (retry ladder / DLQ) is a shared, separately-audited
 * concern; here we pin the handler contract: WHICH collections are dropped, that
 * the `{ projectId }` filter isolates the tenant, that a poison message is
 * terminal (dead_letter), and that the feature flag gates subscription.
 */

/** A fake Mongo collection that records the filters passed to deleteMany. */
class FakeCollection {
  readonly calls: Record<string, unknown>[] = [];
  constructor(private readonly deletedCount = 3) {}
  async deleteMany(filter: Record<string, unknown>) {
    this.calls.push(filter);
    return { deletedCount: this.deletedCount };
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
  return {
    mongo: { getDb: () => db } as never,
    collections,
  };
}

const envelope = (projectId?: string) => ({
  type: 'control.project.purged',
  projectId,
  payload: {},
});

describe('contact ProjectPurgeConsumer.handle', () => {
  const OLD = process.env.PROJECT_PURGE_CONSUMERS_ENABLED;
  afterEach(() => {
    process.env.PROJECT_PURGE_CONSUMERS_ENABLED = OLD;
  });

  it('drops every per-project collection filtered by { projectId }', async () => {
    const { mongo, collections } = makeMongo();
    const rabbit = { consume: jest.fn() } as never;
    const c = new ProjectPurgeConsumer(mongo, rabbit);

    const outcome = await c.handle(envelope('p1') as Record<string, unknown>);

    expect(outcome).toBe('purged');
    expect([...collections.keys()]).toEqual(['contacts']);
    expect(collections.get('contacts')!.calls).toEqual([{ projectId: 'p1' }]);
  });

  it('isolation: a foreign project is never touched — filter is exactly { projectId }', async () => {
    const { mongo, collections } = makeMongo();
    const c = new ProjectPurgeConsumer(mongo, { consume: jest.fn() } as never);
    await c.handle(envelope('tenant-A') as Record<string, unknown>);
    for (const coll of collections.values()) {
      for (const filter of coll.calls) {
        expect(filter).toEqual({ projectId: 'tenant-A' });
      }
    }
  });

  it('poison message (missing projectId) → dead_letter, nothing deleted', async () => {
    const { mongo, collections } = makeMongo();
    const c = new ProjectPurgeConsumer(mongo, { consume: jest.fn() } as never);

    expect(await c.handle(envelope(undefined) as Record<string, unknown>)).toBe('dead_letter');
    expect(await c.handle(envelope('   ') as Record<string, unknown>)).toBe('dead_letter');
    expect(collections.size).toBe(0);
  });

  it('propagates a Mongo error (→ retry ladder / DLQ) instead of swallowing it', async () => {
    const db = {
      collection: () => ({
        deleteMany: async () => {
          throw new Error('mongo down');
        },
      }),
    };
    const c = new ProjectPurgeConsumer(
      { getDb: () => db } as never,
      { consume: jest.fn() } as never,
    );
    await expect(c.handle(envelope('p1') as Record<string, unknown>)).rejects.toThrow('mongo down');
  });
});

describe('contact ProjectPurgeConsumer.onModuleInit', () => {
  const OLD = process.env.PROJECT_PURGE_CONSUMERS_ENABLED;
  afterEach(() => {
    process.env.PROJECT_PURGE_CONSUMERS_ENABLED = OLD;
  });

  it('subscribes when enabled (default)', async () => {
    delete process.env.PROJECT_PURGE_CONSUMERS_ENABLED;
    const consume = jest.fn().mockResolvedValue(undefined);
    const c = new ProjectPurgeConsumer({ getDb: () => ({}) } as never, { consume } as never);
    await c.onModuleInit();
    expect(consume).toHaveBeenCalledTimes(1);
    expect(consume.mock.calls[0][1]).toEqual(['control.project.purged']);
  });

  it('does NOT subscribe when the flag is off', async () => {
    process.env.PROJECT_PURGE_CONSUMERS_ENABLED = 'false';
    const consume = jest.fn();
    const c = new ProjectPurgeConsumer({ getDb: () => ({}) } as never, { consume } as never);
    await c.onModuleInit();
    expect(consume).not.toHaveBeenCalled();
  });
});
