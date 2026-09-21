import { Logger } from '@nestjs/common';
import { ProjectPurgeConsumer } from './project-purge.consumer';

/** Smoke test for the activity project-purge consumer (be-purged-consumers). */
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

describe('activity ProjectPurgeConsumer', () => {
  it('drops crm_activities filtered by { projectId }', async () => {
    const { mongo, collections } = makeMongo();
    const c = new ProjectPurgeConsumer(mongo, { consume: jest.fn() } as never);
    expect(await c.handle(env('p1'))).toBe('purged');
    expect([...collections.keys()]).toEqual(['crm_activities']);
    expect(collections.get('crm_activities')!.calls).toEqual([{ projectId: 'p1' }]);
  });

  it('poison message → dead_letter, nothing deleted', async () => {
    const { mongo, collections } = makeMongo();
    const c = new ProjectPurgeConsumer(mongo, { consume: jest.fn() } as never);
    expect(await c.handle(env(undefined))).toBe('dead_letter');
    expect(collections.size).toBe(0);
  });

  it('reports deleted row counts in the purge log payload', async () => {
    const deleteMany = jest.fn().mockResolvedValue({ deletedCount: 3 });
    const mongo = {
      getDb: () => ({
        collection: () => ({ deleteMany }),
      }),
    } as never;
    const log = jest.spyOn(Logger.prototype, 'log').mockImplementation();
    const c = new ProjectPurgeConsumer(mongo, { consume: jest.fn() } as never);
    expect(await c.handle(env('p2'))).toBe('purged');
    expect(deleteMany).toHaveBeenCalledWith({ projectId: 'p2' });
    expect(log).toHaveBeenCalledWith('purged project p2: crm_activities=3');
    log.mockRestore();
  });
});

describe('activity ProjectPurgeConsumer.onModuleInit', () => {
  const OLD = process.env.PROJECT_PURGE_CONSUMERS_ENABLED;
  afterEach(() => {
    process.env.PROJECT_PURGE_CONSUMERS_ENABLED = OLD;
  });

  it('subscribes when enabled (default)', async () => {
    delete process.env.PROJECT_PURGE_CONSUMERS_ENABLED;
    const consume = jest.fn().mockResolvedValue(undefined);
    const c = new ProjectPurgeConsumer({ getDb: jest.fn() } as never, { consume } as never);
    await c.onModuleInit();
    expect(consume).toHaveBeenCalledTimes(1);
    expect(consume.mock.calls[0][1]).toEqual(['control.project.purged']);
  });

  it('does NOT subscribe when the flag is off', async () => {
    process.env.PROJECT_PURGE_CONSUMERS_ENABLED = 'false';
    const consume = jest.fn();
    const c = new ProjectPurgeConsumer({ getDb: jest.fn() } as never, { consume } as never);
    await c.onModuleInit();
    expect(consume).not.toHaveBeenCalled();
  });

  it('swallows bind failure without throwing (reconnect loop owns recovery)', async () => {
    delete process.env.PROJECT_PURGE_CONSUMERS_ENABLED;
    const consume = jest.fn().mockRejectedValue(new Error('bind failed'));
    const c = new ProjectPurgeConsumer({ getDb: jest.fn() } as never, { consume } as never);
    await expect(c.onModuleInit()).resolves.toBeUndefined();
  });
});
