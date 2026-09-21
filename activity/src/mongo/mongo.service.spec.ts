import { MongoClient } from 'mongodb';
import { AppConfigService } from '../config/app-config.service';
import { MongoService } from './mongo.service';

jest.mock('mongodb', () => {
  const actual = jest.requireActual('mongodb');
  return {
    ...actual,
    MongoClient: jest.fn(),
  };
});

const MongoClientMock = MongoClient as unknown as jest.Mock;

describe('MongoService', () => {
  const config = { databaseUrl: 'mongodb://localhost:27017/fairflow' } as AppConfigService;

  afterEach(() => {
    MongoClientMock.mockReset();
    jest.useRealTimers();
  });

  it('getDb and getClient throw before connect', () => {
    const svc = new MongoService(config);
    expect(() => svc.getDb()).toThrow('MongoDB not connected');
    expect(() => svc.getClient()).toThrow('MongoDB not connected');
  });

  it('onModuleDestroy is safe when never connected', async () => {
    const svc = new MongoService(config);
    await expect(svc.onModuleDestroy()).resolves.toBeUndefined();
  });

  it('healthPing delegates to admin().ping()', async () => {
    const ping = jest.fn().mockResolvedValue(undefined);
    const svc = new MongoService(config);
    (svc as unknown as { db: { admin: () => { ping: typeof ping } } }).db = {
      admin: () => ({ ping }),
    };
    await svc.healthPing();
    expect(ping).toHaveBeenCalled();
  });

  it('activities/outbox/idempotencyKeys use the connected db', () => {
    const collection = jest.fn((name: string) => ({ name }));
    const svc = new MongoService(config);
    (svc as unknown as { db: { collection: typeof collection } }).db = { collection };

    expect(svc.activities()).toEqual({ name: 'crm_activities' });
    expect(svc.outbox()).toEqual({ name: '_outbox' });
    expect(svc.idempotencyKeys()).toEqual({ name: 'idempotency_keys' });
    expect(collection).toHaveBeenCalledWith('crm_activities');
  });

  it('ensureActivityIndexes creates expected compound indexes best-effort', async () => {
    const createIndex = jest.fn().mockResolvedValue('ok');
    const coll = { createIndex };
    const svc = new MongoService(config);
    (svc as unknown as { db: { collection: () => typeof coll } }).db = {
      collection: () => coll,
    };

    await (
      svc as unknown as { ensureActivityIndexes: () => Promise<void> }
    ).ensureActivityIndexes();

    expect(createIndex).toHaveBeenCalledWith(
      { projectId: 1, status: 1, dueDate: 1 },
      { name: 'project_status_due' },
    );
    expect(createIndex).toHaveBeenCalledWith(
      { projectId: 1, 'links.entityId': 1 },
      { name: 'project_link_entity' },
    );
    expect(createIndex).toHaveBeenCalledWith(
      { projectId: 1, assigneeId: 1, dueDate: 1 },
      { name: 'project_assignee_due' },
    );
  });

  it('ensureOutboxIndexes creates status and TTL indexes best-effort', async () => {
    const createIndex = jest.fn().mockResolvedValue('ok');
    const coll = { createIndex };
    const svc = new MongoService(config);
    (svc as unknown as { db: { collection: () => typeof coll } }).db = {
      collection: () => coll,
    };

    await (svc as unknown as { ensureOutboxIndexes: () => Promise<void> }).ensureOutboxIndexes();

    expect(createIndex).toHaveBeenCalledWith(
      { status: 1, createdAt: 1 },
      { name: 'status_created' },
    );
    expect(createIndex).toHaveBeenCalledWith(
      { publishedAt: 1 },
      expect.objectContaining({
        name: 'ttl_published',
        partialFilterExpression: { status: 'published' },
      }),
    );
  });

  it('ensureActivityIndexes продолжает после ошибки одного индекса', async () => {
    const createIndex = jest
      .fn()
      .mockRejectedValueOnce(new Error('index clash'))
      .mockResolvedValue('ok');
    const coll = { createIndex };
    const svc = new MongoService(config);
    (svc as unknown as { db: { collection: () => typeof coll } }).db = {
      collection: () => coll,
    };

    await (
      svc as unknown as { ensureActivityIndexes: () => Promise<void> }
    ).ensureActivityIndexes();

    expect(createIndex).toHaveBeenCalledTimes(3);
  });

  it('connectWithRetry подключается после transient failure', async () => {
    jest.useFakeTimers();
    const close = jest.fn().mockResolvedValue(undefined);
    const connect = jest
      .fn()
      .mockRejectedValueOnce(new Error('refused'))
      .mockResolvedValueOnce(undefined);
    const createIndex = jest.fn().mockResolvedValue('ok');
    const client = {
      connect,
      close,
      db: () => ({
        collection: () => ({ createIndex }),
      }),
    };
    MongoClientMock.mockImplementation(() => client);

    const svc = new MongoService(config);
    const init = svc.onModuleInit();
    await jest.runOnlyPendingTimersAsync();
    await init;

    expect(connect).toHaveBeenCalledTimes(2);
    expect(() => svc.getDb()).not.toThrow();
    await svc.onModuleDestroy();
  });

  it('onModuleDestroy прерывает backoff-wait connectWithRetry', async () => {
    jest.useFakeTimers();
    const close = jest.fn().mockResolvedValue(undefined);
    MongoClientMock.mockImplementation(() => ({
      connect: jest.fn().mockRejectedValue(new Error('down')),
      close,
      db: () => ({}),
    }));

    const svc = new MongoService(config);
    const init = svc.onModuleInit();
    await svc.onModuleDestroy();
    await jest.runOnlyPendingTimersAsync();
    await init.catch(() => undefined);

    expect(close).toHaveBeenCalled();
    expect((svc as unknown as { destroyed: boolean }).destroyed).toBe(true);
  });

  it('connectWithRetry закрывает клиент если destroyed сразу после connect', async () => {
    const close = jest.fn().mockResolvedValue(undefined);
    const createIndex = jest.fn().mockResolvedValue('ok');
    const client = {
      connect: jest.fn().mockResolvedValue(undefined),
      close,
      db: () => ({
        collection: () => ({ createIndex }),
      }),
    };
    MongoClientMock.mockImplementation(() => client);

    const svc = new MongoService(config);
    const connectPromise = (
      svc as unknown as { connectWithRetry: () => Promise<void> }
    ).connectWithRetry();
    (svc as unknown as { destroyed: boolean }).destroyed = true;
    await connectPromise;

    expect(close).toHaveBeenCalled();
    expect(() => svc.getDb()).toThrow('MongoDB not connected');
  });

  it('ensureIdempotencyIndexes creates unique and TTL indexes best-effort', async () => {
    const createIndex = jest.fn().mockResolvedValue('ok');
    const coll = { createIndex };
    const svc = new MongoService(config);
    (svc as unknown as { db: { collection: () => typeof coll } }).db = {
      collection: () => coll,
    };

    await (
      svc as unknown as { ensureIdempotencyIndexes: () => Promise<void> }
    ).ensureIdempotencyIndexes();

    expect(createIndex).toHaveBeenCalledWith(
      { projectId: 1, key: 1 },
      { name: 'projectId_key_unique', unique: true },
    );
    expect(createIndex).toHaveBeenCalledWith(
      { createdAt: 1 },
      expect.objectContaining({ name: 'ttl_createdAt' }),
    );
  });
});
