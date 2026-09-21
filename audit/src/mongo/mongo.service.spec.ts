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

function makeService() {
  const indexes: Array<{ collection: string; key: AnyRec; opts: AnyRec }> = [];
  const ping = jest.fn().mockResolvedValue(undefined);
  const close = jest.fn().mockResolvedValue(undefined);

  const db = {
    admin: () => ({ ping }),
    collection: (name: string) => ({
      createIndex: async (key: AnyRec, options: AnyRec) => {
        indexes.push({ collection: name, key, opts: options });
        return 'ok';
      },
    }),
  };

  const client = { close, db: () => db };
  const config = { get: (key: string) => (key === 'MONGODB_URI' ? 'mongodb://stub' : undefined) };
  const service = new MongoService(config as never);
  (service as unknown as { client: unknown; db: unknown }).client = client;
  (service as unknown as { db: unknown }).db = db;
  return { service, indexes, ping, close };
}

describe('MongoService.ensureIndexes', () => {
  it('creates hash-chain, query and dedup indexes for audit collections', async () => {
    const { service, indexes } = makeService();
    await (service as unknown as { ensureIndexes(): Promise<void> }).ensureIndexes();

    const events = indexes.filter((i) => i.collection === 'audit_events');
    expect(events.map((i) => i.key)).toEqual(
      expect.arrayContaining([
        { chainKey: 1, seq: 1 },
        { projectId: 1, entityType: 1, entityId: 1, createdAt: -1 },
        { projectId: 1, actorId: 1, createdAt: -1 },
        { projectId: 1, traceId: 1 },
        { idempotencyKey: 1 },
      ]),
    );
    expect(events.find((i) => i.key.chainKey)?.opts).toMatchObject({ unique: true, sparse: true });

    const processed = indexes.find((i) => i.collection === 'processed_messages');
    expect(processed?.key).toEqual({ processedAt: 1 });
    expect(processed?.opts).toMatchObject({ expireAfterSeconds: 7 * 24 * 60 * 60 });
  });

  it('swallows index creation errors (best-effort boot)', async () => {
    const { service } = makeService();
    const eventsCol = service.auditEvents();
    jest.spyOn(eventsCol, 'createIndex').mockRejectedValueOnce(new Error('index conflict'));
    await expect(
      (service as unknown as { ensureIndexes(): Promise<void> }).ensureIndexes(),
    ).resolves.toBeUndefined();
  });
});

describe('MongoService runtime helpers', () => {
  it('healthPing delegates to db.admin().ping()', async () => {
    const { service, ping } = makeService();
    await service.healthPing();
    expect(ping).toHaveBeenCalled();
  });

  it('exposes the three audit collections on the configured db handle', () => {
    const names: string[] = [];
    const config = { get: () => 'mongodb://stub' };
    const service = new MongoService(config as never);
    (service as unknown as { db: { collection: (n: string) => object } }).db = {
      collection: (name: string) => {
        names.push(name);
        return {};
      },
    };
    service.auditEvents();
    service.auditChainHeads();
    service.processedMessages();
    expect(names).toEqual(['audit_events', 'audit_chain_heads', 'processed_messages']);
  });

  it('onModuleDestroy closes the client and interrupts an in-flight retry wait', async () => {
    const config = { get: () => 'mongodb://stub' };
    const service = new MongoService(config as never);
    const close = jest.fn().mockResolvedValue(undefined);
    (service as unknown as { client: { close: jest.Mock } }).client = { close };

    const waitPromise = (service as unknown as { wait(ms: number): Promise<void> }).wait(60_000);
    await service.onModuleDestroy();
    await expect(waitPromise).resolves.toBeUndefined();
    expect(close).toHaveBeenCalled();
  });

  it('connectWithRetry throws when MONGODB_URI is missing', async () => {
    const service = new MongoService({ get: () => undefined } as never);
    await expect(
      (service as unknown as { connectWithRetry(): Promise<void> }).connectWithRetry(),
    ).rejects.toThrow('MONGODB_URI is required');
  });
});

describe('MongoService.connectWithRetry', () => {
  afterEach(() => {
    MongoClientMock.mockReset();
    jest.useRealTimers();
  });

  it('onModuleInit connects on the first attempt and creates indexes', async () => {
    const createIndex = jest.fn().mockResolvedValue('ok');
    const connect = jest.fn().mockResolvedValue(undefined);
    const close = jest.fn().mockResolvedValue(undefined);
    MongoClientMock.mockImplementation(() => ({
      connect,
      close,
      db: () => ({
        collection: () => ({ createIndex }),
      }),
    }));

    const svc = new MongoService({ get: () => 'mongodb://stub' } as never);
    await svc.onModuleInit();

    expect(connect).toHaveBeenCalledTimes(1);
    expect(createIndex).toHaveBeenCalled();
    await svc.onModuleDestroy();
    expect(close).toHaveBeenCalled();
  });

  it('retries with backoff after a transient connection failure', async () => {
    jest.useFakeTimers();
    const close = jest.fn().mockResolvedValue(undefined);
    const connect = jest.fn().mockRejectedValueOnce(new Error('refused')).mockResolvedValueOnce(undefined);
    MongoClientMock.mockImplementation(() => ({
      connect,
      close,
      db: () => ({
        collection: () => ({ createIndex: jest.fn().mockResolvedValue('ok') }),
      }),
    }));

    const svc = new MongoService({ get: () => 'mongodb://stub' } as never);
    const init = svc.onModuleInit();
    await jest.runOnlyPendingTimersAsync();
    await init;

    expect(connect).toHaveBeenCalledTimes(2);
    await svc.onModuleDestroy();
  });

  it('closes the client when destroyed wins the race during connect', async () => {
    const close = jest.fn().mockResolvedValue(undefined);
    let resolveConnect: () => void;
    const connect = jest.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveConnect = resolve;
        }),
    );
    MongoClientMock.mockImplementation(() => ({
      connect,
      close,
      db: () => ({ collection: () => ({ createIndex: jest.fn() }) }),
    }));

    const svc = new MongoService({ get: () => 'mongodb://stub' } as never);
    const init = svc.onModuleInit();
    await svc.onModuleDestroy();
    resolveConnect!();
    await init;

    expect(close).toHaveBeenCalled();
  });
});
