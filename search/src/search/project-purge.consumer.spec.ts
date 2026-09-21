import { ProjectPurgeConsumer } from './project-purge.consumer';

/**
 * Unit tests for the search project-purge consumer (be-purged-consumers).
 *
 * TODO-255: search purges ONLY the data it owns — the derived
 * `search_index`/`search_index_state`. The CRM source collections
 * (`crm_deals`/`crm_orders`/`crm_products`/`crm_activities`/`contacts`/`companies`)
 * belong to their own domains; search merely READS them in the recovery reindex,
 * it keeps no "read-model copies", and deleting them from here destroyed another
 * domain's data. Here we pin that exact collection set, that the source
 * collections are never touched, tenant isolation, the poison → dead_letter path,
 * and the flag gate.
 */

class FakeCollection {
  readonly calls: Record<string, unknown>[] = [];
  async deleteMany(filter: Record<string, unknown>) {
    this.calls.push(filter);
    return { deletedCount: 1 };
  }
}

function makeMongo() {
  /** Collections search owns and must purge. */
  const owned = {
    search_index: new FakeCollection(),
    search_index_state: new FakeCollection(),
  };
  /** Foreign source collections — must never be written by this consumer. */
  const foreign = {
    crm_deals: new FakeCollection(),
    crm_orders: new FakeCollection(),
    crm_products: new FakeCollection(),
    crm_activities: new FakeCollection(),
    contacts: new FakeCollection(),
    companies: new FakeCollection(),
  };
  const mongo = {
    searchIndex: () => owned.search_index,
    searchIndexState: () => owned.search_index_state,
    deals: () => foreign.crm_deals,
    orders: () => foreign.crm_orders,
    products: () => foreign.crm_products,
    activities: () => foreign.crm_activities,
    contacts: () => foreign.contacts,
    companies: () => foreign.companies,
  } as never;
  return { mongo, c: owned, foreign };
}

const envelope = (projectId?: string) => ({
  type: 'control.project.purged',
  projectId,
  payload: {},
});

describe('search ProjectPurgeConsumer.handle', () => {
  const OLD = process.env.PROJECT_PURGE_CONSUMERS_ENABLED;
  afterEach(() => {
    process.env.PROJECT_PURGE_CONSUMERS_ENABLED = OLD;
  });

  it('drops ONLY the derived search collections, filtered by { projectId } (TODO-255)', async () => {
    const { mongo, c, foreign } = makeMongo();
    const consumer = new ProjectPurgeConsumer(mongo, { consumeEvents: jest.fn() } as never);

    const outcome = await consumer.handle(envelope('p9') as Record<string, unknown>);

    expect(outcome).toBe('purged');
    for (const coll of Object.values(c)) {
      expect(coll.calls).toEqual([{ projectId: 'p9' }]);
    }
    // Foreign domain data survives the search purge.
    for (const coll of Object.values(foreign)) {
      expect(coll.calls).toHaveLength(0);
    }
  });

  it('isolation: filter is exactly { projectId } for the purged tenant', async () => {
    const { mongo, c, foreign } = makeMongo();
    const consumer = new ProjectPurgeConsumer(mongo, { consumeEvents: jest.fn() } as never);
    await consumer.handle(envelope('tenant-Z') as Record<string, unknown>);
    for (const coll of Object.values(c)) {
      expect(coll.calls[0]).toEqual({ projectId: 'tenant-Z' });
    }
    for (const coll of Object.values(foreign)) {
      expect(coll.calls).toHaveLength(0);
    }
  });

  it('poison message (missing projectId) → dead_letter, nothing deleted', async () => {
    const { mongo, c, foreign } = makeMongo();
    const consumer = new ProjectPurgeConsumer(mongo, { consumeEvents: jest.fn() } as never);
    expect(await consumer.handle(envelope(undefined) as Record<string, unknown>)).toBe(
      'dead_letter',
    );
    for (const coll of [...Object.values(c), ...Object.values(foreign)]) {
      expect(coll.calls).toHaveLength(0);
    }
  });
});

describe('search ProjectPurgeConsumer.onModuleInit', () => {
  const OLD = process.env.PROJECT_PURGE_CONSUMERS_ENABLED;
  afterEach(() => {
    process.env.PROJECT_PURGE_CONSUMERS_ENABLED = OLD;
  });

  it('subscribes when enabled (default)', async () => {
    delete process.env.PROJECT_PURGE_CONSUMERS_ENABLED;
    const consumeEvents = jest.fn().mockResolvedValue(undefined);
    const consumer = new ProjectPurgeConsumer({} as never, { consumeEvents } as never);
    await consumer.onModuleInit();
    expect(consumeEvents).toHaveBeenCalledTimes(1);
    expect(consumeEvents.mock.calls[0][1]).toEqual(['control.project.purged']);
  });

  it('does NOT subscribe when the flag is off', async () => {
    process.env.PROJECT_PURGE_CONSUMERS_ENABLED = 'false';
    const consumeEvents = jest.fn();
    const consumer = new ProjectPurgeConsumer({} as never, { consumeEvents } as never);
    await consumer.onModuleInit();
    expect(consumeEvents).not.toHaveBeenCalled();
  });
});
