import { MongoService } from './mongo.service';

/**
 * Index/dedup coverage for the storage layer (TODO-410, TODO-415). Mongo is
 * stubbed: `ensureIndexes`/`dedupOrderNumbers` are exercised against a fake `Db`,
 * no real infra.
 */
type AnyRec = Record<string, unknown>;

function makeService(opts: { dupGroups?: AnyRec[] } = {}) {
  const indexes: Array<{ collection: string; key: AnyRec; opts: AnyRec }> = [];
  const updates: Array<{ collection: string; query: AnyRec; update: AnyRec }> = [];

  const db = {
    collection: (collection: string) => ({
      createIndex: async (key: AnyRec, options: AnyRec) => {
        indexes.push({ collection, key, opts: options });
        return 'ok';
      },
      aggregate: () => ({ toArray: async () => opts.dupGroups ?? [] }),
      updateOne: async (query: AnyRec, update: AnyRec) => {
        updates.push({ collection, query, update });
        return { modifiedCount: 1 };
      },
      findOneAndUpdate: async () => ({ seq: 7 }),
    }),
  };

  const service = new MongoService({ databaseUrl: 'mongodb://stub' } as never);
  (service as unknown as { db: unknown }).db = db;
  return { service, indexes, updates };
}

describe('MongoService.ensureIndexes', () => {
  it('creates the pinned-revision lookup index (TODO-415)', async () => {
    const { service, indexes } = makeService();
    await (service as unknown as { ensureIndexes(): Promise<void> }).ensureIndexes();
    const revision = indexes.find((i) => i.collection === 'crm_order_type_revisions');
    expect(revision).toBeDefined();
    // moveOrder resolves the frozen revision by (projectId, orderTypeId, version).
    expect(revision?.key).toEqual({ projectId: 1, orderTypeId: 1, version: -1 });
    expect(revision?.opts).toMatchObject({ name: 'project_type_version' });
  });

  it('still creates the pre-existing crm_orders indexes', async () => {
    const { service, indexes } = makeService();
    await (service as unknown as { ensureIndexes(): Promise<void> }).ensureIndexes();
    const names = indexes.filter((i) => i.collection === 'crm_orders').map((i) => i.opts.name);
    expect(names).toEqual(
      expect.arrayContaining([
        'project_updatedAt',
        'project_type_stage',
        'sending_watchdog',
        'uniq_project_number',
      ]),
    );
  });
});

describe('MongoService connectivity guards', () => {
  it('getDb и getClient бросают, если Mongo ещё не подключён', () => {
    const service = new MongoService({ databaseUrl: 'mongodb://stub' } as never);
    expect(() => service.getDb()).toThrow(/not connected/);
    expect(() => service.getClient()).toThrow(/not connected/);
  });

  it('nextOrderNumber возвращает seq из атомарного счётчика', async () => {
    const service = new MongoService({ databaseUrl: 'mongodb://stub' } as never);
    (service as unknown as { db: unknown }).db = {
      collection: () => ({
        findOneAndUpdate: async () => ({ seq: 12 }),
      }),
    };
    await expect(service.nextOrderNumber('p1')).resolves.toBe(12);
  });

  it('healthPing делегирует admin().ping()', async () => {
    const ping = jest.fn(async () => undefined);
    const service = new MongoService({ databaseUrl: 'mongodb://stub' } as never);
    (service as unknown as { db: unknown }).db = {
      admin: () => ({ ping }),
    };
    await expect(service.healthPing()).resolves.toBeUndefined();
    expect(ping).toHaveBeenCalled();
  });

  it('createIndexBestEffort проглатывает ошибку одного индекса и продолжает boot', async () => {
    const { service, indexes } = makeService();
    const db = (service as unknown as { db: { collection: (n: string) => unknown } }).db;
    const orig = db.collection.bind(db);
    db.collection = (name: string) => {
      const coll = orig(name) as { createIndex: jest.Mock };
      if (name === 'crm_orders') {
        return {
          ...coll,
          createIndex: async (key: Record<string, unknown>, options: Record<string, unknown>) => {
            if (options.name === 'project_updatedAt') throw new Error('index clash');
            return coll.createIndex(key, options);
          },
        };
      }
      return coll;
    };
    await (service as unknown as { ensureIndexes(): Promise<void> }).ensureIndexes();
    expect(indexes.some((i) => i.opts.name === 'project_type_stage')).toBe(true);
  });
});

describe('MongoService.dedupOrderNumbers', () => {
  it('stamps updatedAt as epoch millis, not a BSON Date (TODO-410)', async () => {
    // A BSON Date sorts before every Number, so the SENDING watchdog cutoff
    // (`updatedAt: { $lt: <number> }`) would never match a renumbered order.
    const { service, updates } = makeService({
      dupGroups: [{ _id: { projectId: 'p1', number: 'ORD-00001' }, ids: ['a', 'b', 'c'] }],
    });
    await (service as unknown as { dedupOrderNumbers(): Promise<void> }).dedupOrderNumbers();
    expect(updates).toHaveLength(2); // first row kept, the two collisions renumbered
    for (const u of updates) {
      const set = (u.update as { $set: AnyRec }).$set;
      expect(typeof set.updatedAt).toBe('number');
      expect(set.updatedAt).not.toBeInstanceOf(Date);
      expect(set.number).toBe('ORD-00007');
    }
  });

  it('ничего не делает, если дубликатов нет', async () => {
    const { service, updates } = makeService({ dupGroups: [] });
    await (service as unknown as { dedupOrderNumbers(): Promise<void> }).dedupOrderNumbers();
    expect(updates).toHaveLength(0);
  });
});

describe('MongoService collection accessors', () => {
  it('orderTypes/orders/idempotencyKeys/orderCounters/orderTypeRevisions/outbox делегируют в getDb', () => {
    const coll = jest.fn((name: string) => ({ name }));
    const service = new MongoService({ databaseUrl: 'mongodb://stub' } as never);
    (service as unknown as { db: unknown }).db = { collection: coll };
    expect(service.orderTypes()).toEqual({ name: 'crm_order_types' });
    expect(service.orders()).toEqual({ name: 'crm_orders' });
    expect(service.idempotencyKeys()).toEqual({ name: 'idempotency_keys' });
    expect(service.orderCounters()).toEqual({ name: 'crm_order_counters' });
    expect(service.orderTypeRevisions()).toEqual({ name: 'crm_order_type_revisions' });
    expect(service.outbox()).toEqual({ name: 'crm_event_outbox' });
    expect(service.eventOutbox()).toEqual({ name: 'crm_event_outbox' });
    expect(coll).toHaveBeenCalledTimes(7);
  });

  it('nextOrderNumber возвращает 1, если findOneAndUpdate не вернул seq', async () => {
    const service = new MongoService({ databaseUrl: 'mongodb://stub' } as never);
    (service as unknown as { db: unknown }).db = {
      collection: () => ({
        findOneAndUpdate: async () => null,
      }),
    };
    await expect(service.nextOrderNumber('p1')).resolves.toBe(1);
  });
});

describe('MongoService.connectWithRetry', () => {
  const { MongoClient } = jest.requireActual<typeof import('mongodb')>('mongodb');

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it('onModuleInit подключается с первой попытки', async () => {
    const connectSpy = jest.spyOn(MongoClient.prototype, 'connect').mockImplementation(function (
      this: InstanceType<typeof MongoClient>,
    ) {
      return Promise.resolve(this);
    });
    jest.spyOn(MongoClient.prototype, 'db').mockReturnValue({
      collection: jest.fn().mockReturnValue({
        createIndex: jest.fn().mockResolvedValue('ok'),
        aggregate: jest.fn().mockReturnValue({ toArray: jest.fn().mockResolvedValue([]) }),
      }),
    } as never);
    jest.spyOn(MongoClient.prototype, 'close').mockResolvedValue(undefined);

    const service = new MongoService({ databaseUrl: 'mongodb://ok' } as never);
    await service.onModuleInit();
    expect(connectSpy).toHaveBeenCalled();
    await service.onModuleDestroy();
  });

  it('onModuleDestroy прерывает backoff между попытками', async () => {
    jest.useFakeTimers();
    jest.spyOn(MongoClient.prototype, 'connect').mockRejectedValue(new Error('mongo down'));
    jest.spyOn(MongoClient.prototype, 'close').mockResolvedValue(undefined);

    const service = new MongoService({ databaseUrl: 'mongodb://retry' } as never);
    const init = service.onModuleInit();
    await jest.advanceTimersByTimeAsync(500);
    await service.onModuleDestroy();
    await init.catch(() => undefined);
    expect(MongoClient.prototype.connect).toHaveBeenCalled();
  });
});
