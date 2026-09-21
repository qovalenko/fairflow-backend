import { MongoClient } from 'mongodb';
import { MongoService } from './mongo.service';

jest.mock('mongodb', () => {
  const actual = jest.requireActual('mongodb');
  return {
    ...actual,
    MongoClient: jest.fn(),
  };
});

const MongoClientMock = MongoClient as unknown as jest.Mock;

type AnyRec = Record<string, unknown>;

function makeConnectedService() {
  const indexes: Array<{ collection: string; key: AnyRec; opts: AnyRec }> = [];
  const ping = jest.fn().mockResolvedValue(undefined);
  const db = {
    admin: () => ({ ping }),
    collection: (name: string) => ({
      collectionName: name,
      createIndex: async (key: AnyRec, options: AnyRec) => {
        indexes.push({ collection: name, key, opts: options });
        return 'ok';
      },
    }),
  };
  const close = jest.fn().mockResolvedValue(undefined);
  const client = { close, db: () => db };
  const service = new MongoService({ databaseUrl: 'mongodb://stub' } as never);
  (service as unknown as { client: unknown; db: unknown }).client = client;
  (service as unknown as { db: unknown }).db = db;
  return { service, indexes, ping, close, client, db };
}

describe('MongoService collection accessors', () => {
  it('throws when Mongo is not connected', () => {
    const service = new MongoService({ databaseUrl: 'mongodb://stub' } as never);
    expect(() => service.getDb()).toThrow('MongoDB not connected');
    expect(() => service.getClient()).toThrow('MongoDB not connected');
    expect(() => service.products()).toThrow('MongoDB not connected');
  });

  it('returns the expected CRM collection names when connected', () => {
    const { service } = makeConnectedService();
    expect(service.products().collectionName).toBe('crm_products');
    expect(service.deals().collectionName).toBe('crm_deals');
    expect(service.orders().collectionName).toBe('crm_orders');
    expect(service.outbox().collectionName).toBe('crm_event_outbox');
    expect(service.usageProcessed().collectionName).toBe('crm_product_usage_processed');
    expect(service.idempotencyKeys().collectionName).toBe('idempotency_keys');
  });

  it('healthPing delegates to db.admin().ping()', async () => {
    const { service, ping } = makeConnectedService();
    await service.healthPing();
    expect(ping).toHaveBeenCalled();
  });
});

describe('MongoService index bootstrap', () => {
  it('ensures product list/status indexes', async () => {
    const { service, indexes } = makeConnectedService();
    await (service as unknown as { ensureProductIndexes(): Promise<void> }).ensureProductIndexes();
    const productIdx = indexes.filter((i) => i.collection === 'crm_products');
    expect(productIdx.map((i) => i.opts.name)).toEqual(
      expect.arrayContaining(['project_updated', 'project_status']),
    );
  });

  it('logs and continues when a product index fails', async () => {
    const { service, indexes } = makeConnectedService();
    const coll = service.products();
    jest.spyOn(coll, 'createIndex').mockRejectedValueOnce(new Error('idx down'));
    await (service as unknown as { ensureProductIndexes(): Promise<void> }).ensureProductIndexes();
    expect(indexes.some((i) => i.opts.name === 'project_status')).toBe(true);
  });

  it('ensures outbox relay + TTL indexes', async () => {
    const { service, indexes } = makeConnectedService();
    await (service as unknown as { ensureOutboxIndexes(): Promise<void> }).ensureOutboxIndexes();
    const outboxIdx = indexes.filter((i) => i.collection === 'crm_event_outbox');
    expect(outboxIdx.map((i) => i.opts.name)).toEqual(
      expect.arrayContaining(['status_created', 'ttl_published']),
    );
    const ttl = outboxIdx.find((i) => i.opts.name === 'ttl_published');
    expect(ttl?.opts.partialFilterExpression).toEqual({ status: 'published' });
  });

  it('ensures usage-processed dedup and idempotency ledger indexes', async () => {
    const { service, indexes } = makeConnectedService();
    await (
      service as unknown as { ensureUsageProcessedIndexes(): Promise<void> }
    ).ensureUsageProcessedIndexes();
    await (
      service as unknown as { ensureIdempotencyIndexes(): Promise<void> }
    ).ensureIdempotencyIndexes();
    expect(indexes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          collection: 'crm_product_usage_processed',
          opts: expect.objectContaining({ name: 'dedupKey_unique', unique: true }),
        }),
        expect.objectContaining({
          collection: 'idempotency_keys',
          opts: expect.objectContaining({ name: 'projectId_key_unique', unique: true }),
        }),
        expect.objectContaining({
          collection: 'idempotency_keys',
          opts: expect.objectContaining({ name: 'createdAt_ttl' }),
        }),
      ]),
    );
  });
});

describe('MongoService connectWithRetry', () => {
  afterEach(() => {
    MongoClientMock.mockReset();
    jest.useRealTimers();
  });

  it('connects after a transient failure', async () => {
    jest.useFakeTimers();
    const createIndex = jest.fn().mockResolvedValue('ok');
    const db = { collection: () => ({ createIndex }) };
    const close = jest.fn().mockResolvedValue(undefined);
    const connect = jest
      .fn()
      .mockRejectedValueOnce(new Error('refused'))
      .mockResolvedValueOnce(undefined);
    MongoClientMock.mockImplementation(() => ({ connect, close, db: () => db }));

    const service = new MongoService({ databaseUrl: 'mongodb://stub' } as never);
    const init = service.onModuleInit();
    await jest.runOnlyPendingTimersAsync();
    await init;

    expect(connect).toHaveBeenCalledTimes(2);
    expect(createIndex).toHaveBeenCalled();
    await service.onModuleDestroy();
  });

  it('onModuleDestroy interrupts backoff wait and closes the client', async () => {
    jest.useFakeTimers();
    const close = jest.fn().mockResolvedValue(undefined);
    MongoClientMock.mockImplementation(() => ({
      connect: jest.fn().mockRejectedValue(new Error('down')),
      close,
      db: () => ({ collection: () => ({ createIndex: jest.fn() }) }),
    }));

    const service = new MongoService({ databaseUrl: 'mongodb://stub' } as never);
    const waitPromise = (service as unknown as { wait(ms: number): Promise<void> }).wait(60_000);
    const init = service.onModuleInit();
    await service.onModuleDestroy();
    await jest.runOnlyPendingTimersAsync();
    await Promise.all([waitPromise, init.catch(() => undefined)]);

    expect(close).toHaveBeenCalled();
  });

  it('закрывает клиент без bootstrap, если destroyed во время connect', async () => {
    const close = jest.fn().mockResolvedValue(undefined);
    let service!: MongoService;
    const connect = jest.fn().mockImplementation(async () => {
      (service as unknown as { destroyed: boolean }).destroyed = true;
    });
    MongoClientMock.mockImplementation(() => ({
      connect,
      close,
      db: () => ({ collection: () => ({ createIndex: jest.fn() }) }),
    }));

    service = new MongoService({ databaseUrl: 'mongodb://stub' } as never);
    await service.onModuleInit();

    expect(connect).toHaveBeenCalled();
    expect(close).toHaveBeenCalled();
  });

  it('продолжает bootstrap outbox при падении status index', async () => {
    const { service, indexes } = makeConnectedService();
    const coll = service.outbox();
    jest.spyOn(coll, 'createIndex').mockRejectedValueOnce(new Error('status idx down'));
    await (service as unknown as { ensureOutboxIndexes(): Promise<void> }).ensureOutboxIndexes();
    expect(indexes.some((i) => i.opts.name === 'ttl_published')).toBe(true);
  });

  it('логирует и продолжает при падении usage-processed index', async () => {
    const { service } = makeConnectedService();
    const coll = service.usageProcessed();
    jest.spyOn(coll, 'createIndex').mockRejectedValue(new Error('dedup idx down'));
    await expect(
      (
        service as unknown as { ensureUsageProcessedIndexes(): Promise<void> }
      ).ensureUsageProcessedIndexes(),
    ).resolves.toBeUndefined();
  });

  it('логирует и продолжает при падении idempotency indexes', async () => {
    const { service } = makeConnectedService();
    const coll = service.idempotencyKeys();
    jest
      .spyOn(coll, 'createIndex')
      .mockRejectedValueOnce(new Error('unique idx down'))
      .mockRejectedValueOnce(new Error('ttl idx down'));
    await expect(
      (
        service as unknown as { ensureIdempotencyIndexes(): Promise<void> }
      ).ensureIdempotencyIndexes(),
    ).resolves.toBeUndefined();
  });
});
