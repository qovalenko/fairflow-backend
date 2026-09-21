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

function makeService() {
  const ping = jest.fn().mockResolvedValue(undefined);
  const close = jest.fn().mockResolvedValue(undefined);

  const db = {
    admin: () => ({ ping }),
    collection: jest.fn().mockReturnValue({}),
  };

  const client = { close, db: () => db };
  const config = { get: (key: string) => (key === 'MONGODB_URI' ? 'mongodb://stub' : undefined) };
  const service = new MongoService(config as never);
  (service as unknown as { client: unknown; db: unknown }).client = client;
  (service as unknown as { db: unknown }).db = db;
  return { service, ping, close, db };
}

describe('MongoService runtime helpers', () => {
  afterEach(() => {
    MongoClientMock.mockReset();
    jest.useRealTimers();
  });

  it('healthPing delegates to db.admin().ping()', async () => {
    const { service, ping } = makeService();
    await service.healthPing();
    expect(ping).toHaveBeenCalled();
  });

  it('exposes all platform collections on the configured db handle', () => {
    const names: string[] = [];
    const config = { get: () => 'mongodb://stub' };
    const service = new MongoService(config as never);
    (service as unknown as { db: { collection: (n: string) => object } }).db = {
      collection: (name: string) => {
        names.push(name);
        return {};
      },
    };

    service.notifications();
    service.audit();
    service.documentTemplates();
    service.quotaRules();
    service.quotaUsage();
    service.uploadTickets();
    service.webhookLog();

    expect(names).toEqual([
      'platform_notifications',
      'platform_audit_events',
      'platform_document_templates',
      'platform_quota_rules',
      'platform_quota_usage',
      'platform_upload_tickets',
      'platform_webhook_log',
    ]);
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

describe('MongoService connection lifecycle', () => {
  afterEach(async () => {
    MongoClientMock.mockReset();
    jest.useRealTimers();
  });

  it('onModuleInit rejects when MONGODB_URI is not configured', async () => {
    const service = new MongoService({ get: () => undefined } as never);
    await expect(service.onModuleInit()).rejects.toThrow('MONGODB_URI is required');
  });

  it('onModuleInit connects MongoDB on the first attempt', async () => {
    const close = jest.fn().mockResolvedValue(undefined);
    const connect = jest.fn().mockResolvedValue(undefined);
    const db = { collection: jest.fn() };
    MongoClientMock.mockImplementation(() => ({ connect, close, db: () => db }));

    const service = new MongoService({ get: () => 'mongodb://stub' } as never);
    await service.onModuleInit();

    expect(connect).toHaveBeenCalledTimes(1);
    expect(MongoClientMock).toHaveBeenCalledWith('mongodb://stub');
    await service.onModuleDestroy();
    expect(close).toHaveBeenCalled();
  });

  it('connectWithRetry retries with exponential backoff after a transient failure', async () => {
    jest.useFakeTimers();
    const close = jest.fn().mockResolvedValue(undefined);
    const connect = jest
      .fn()
      .mockRejectedValueOnce(new Error('connection refused'))
      .mockRejectedValueOnce(new Error('still down'))
      .mockResolvedValueOnce(undefined);
    MongoClientMock.mockImplementation(() => ({
      connect,
      close,
      db: () => ({ collection: jest.fn() }),
    }));

    const service = new MongoService({ get: () => 'mongodb://stub' } as never);
    const init = service.onModuleInit();
    await Promise.resolve();
    expect(connect).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(1_000);
    await Promise.resolve();
    expect(connect).toHaveBeenCalledTimes(2);
    await jest.advanceTimersByTimeAsync(999);
    expect(connect).toHaveBeenCalledTimes(2);
    await jest.advanceTimersByTimeAsync(1);
    expect(connect).toHaveBeenCalledTimes(2);
    await jest.advanceTimersByTimeAsync(1_000);
    await init;

    expect(connect).toHaveBeenCalledTimes(3);
    expect(close).toHaveBeenCalledTimes(2);
    await service.onModuleDestroy();
  });

  it('onModuleDestroy stops the retry loop and closes the failing client', async () => {
    jest.useFakeTimers();
    const close = jest.fn().mockResolvedValue(undefined);
    MongoClientMock.mockImplementation(() => ({
      connect: jest.fn().mockRejectedValue(new Error('mongo down')),
      close,
      db: () => ({}),
    }));

    const service = new MongoService({ get: () => 'mongodb://stub' } as never);
    const init = service.onModuleInit();
    await service.onModuleDestroy();
    await jest.runOnlyPendingTimersAsync();
    await init.catch(() => undefined);

    expect(close).toHaveBeenCalled();
  });

  it('connectWithRetry discards the client when destroyed during connect', async () => {
    const close = jest.fn().mockResolvedValue(undefined);
    let resolveConnect!: () => void;
    const connect = jest.fn().mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          resolveConnect = resolve;
        }),
    );
    MongoClientMock.mockImplementation(() => ({ connect, close, db: () => ({}) }));

    const service = new MongoService({ get: () => 'mongodb://stub' } as never);
    const connecting = (
      service as unknown as { connectWithRetry(): Promise<void> }
    ).connectWithRetry();
    await service.onModuleDestroy();
    resolveConnect();
    await connecting;

    expect(close).toHaveBeenCalled();
  });

  it('onModuleDestroy completes when no client was connected yet', async () => {
    const service = new MongoService({ get: () => 'mongodb://stub' } as never);
    await expect(service.onModuleDestroy()).resolves.toBeUndefined();
  });
});
