import { ConfigService } from '@nestjs/config';
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

describe('MongoService', () => {
  const prevUri = process.env.MONGODB_URI;

  afterEach(async () => {
    if (prevUri === undefined) delete process.env.MONGODB_URI;
    else process.env.MONGODB_URI = prevUri;
    MongoClientMock.mockReset();
    jest.useRealTimers();
  });

  it('throws on boot when MONGODB_URI is missing', async () => {
    const svc = new MongoService({ get: () => undefined } as unknown as ConfigService);
    await expect(svc.onModuleInit()).rejects.toThrow('MONGODB_URI is required');
  });

  it('exposes the search-domain collections from the connected db', () => {
    const names: string[] = [];
    const db = {
      collection: (name: string) => {
        names.push(name);
        return { name };
      },
      admin: () => ({ ping: jest.fn().mockResolvedValue(undefined) }),
    };
    const svc = new MongoService({ get: () => 'mongodb://stub' } as unknown as ConfigService);
    (svc as unknown as { db: typeof db }).db = db;

    expect(svc.searchIndex()).toEqual({ name: 'search_index' });
    expect(svc.searchIndexState()).toEqual({ name: 'search_index_state' });
    expect(svc.searchEventDedup()).toEqual({ name: 'search_event_dedup' });
    expect(svc.deals()).toEqual({ name: 'crm_deals' });
    expect(svc.orders()).toEqual({ name: 'crm_orders' });
    expect(svc.products()).toEqual({ name: 'crm_products' });
    expect(svc.contacts()).toEqual({ name: 'contacts' });
    expect(svc.companies()).toEqual({ name: 'companies' });
    expect(svc.activities()).toEqual({ name: 'crm_activities' });
    expect(names).toEqual([
      'search_index',
      'search_index_state',
      'search_event_dedup',
      'crm_deals',
      'crm_orders',
      'crm_products',
      'contacts',
      'companies',
      'crm_activities',
    ]);
  });

  it('healthPing delegates to db.admin().ping()', async () => {
    const ping = jest.fn().mockResolvedValue(undefined);
    const svc = new MongoService({ get: () => 'mongodb://stub' } as unknown as ConfigService);
    (svc as unknown as { db: { admin: () => { ping: typeof ping } } }).db = {
      admin: () => ({ ping }),
    };

    await svc.healthPing();
    expect(ping).toHaveBeenCalledTimes(1);
  });

  it('onModuleDestroy stops an in-flight retry backoff and closes the client', async () => {
    jest.useFakeTimers();
    const close = jest.fn().mockResolvedValue(undefined);
    const svc = new MongoService({ get: () => 'mongodb://stub' } as unknown as ConfigService);
    (svc as unknown as { client: { close: typeof close } }).client = { close };

    const waitPromise = (svc as unknown as { wait: (ms: number) => Promise<void> }).wait(60_000);
    const destroyPromise = svc.onModuleDestroy();
    jest.advanceTimersByTime(60_000);

    await Promise.all([waitPromise, destroyPromise]);
    expect(close).toHaveBeenCalledTimes(1);
    jest.useRealTimers();
  });

  it('connectWithRetry succeeds after a transient connection failure', async () => {
    jest.useFakeTimers();
    process.env.MONGODB_URI = 'mongodb://stub';
    const close = jest.fn().mockResolvedValue(undefined);
    const connect = jest.fn().mockRejectedValueOnce(new Error('refused')).mockResolvedValueOnce(undefined);
    const client = { connect, close, db: () => ({}) };
    MongoClientMock.mockImplementation(() => client);

    const svc = new MongoService({ get: (k: string) => process.env[k] } as unknown as ConfigService);
    const init = svc.onModuleInit();
    await jest.runOnlyPendingTimersAsync();
    await init;

    expect(connect).toHaveBeenCalledTimes(2);
    await svc.onModuleDestroy();
  });

  it('onModuleDestroy aborts connectWithRetry while waiting between attempts', async () => {
    jest.useFakeTimers();
    process.env.MONGODB_URI = 'mongodb://stub';
    const close = jest.fn().mockResolvedValue(undefined);
    MongoClientMock.mockImplementation(() => ({
      connect: jest.fn().mockRejectedValue(new Error('down')),
      close,
      db: () => ({}),
    }));

    const svc = new MongoService({ get: (k: string) => process.env[k] } as unknown as ConfigService);
    const init = svc.onModuleInit();
    await svc.onModuleDestroy();
    await jest.runOnlyPendingTimersAsync();
    await init.catch(() => undefined);

    expect(close).toHaveBeenCalled();
  });

  it('onModuleDestroy closes a client that connected during a late destroy race', async () => {
    jest.useFakeTimers();
    process.env.MONGODB_URI = 'mongodb://stub';
    const close = jest.fn().mockResolvedValue(undefined);
    let resolveConnect: (() => void) | undefined;
    const connect = jest.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveConnect = resolve;
        }),
    );
    MongoClientMock.mockImplementation(() => ({ connect, close, db: () => ({}) }));

    const svc = new MongoService({ get: (k: string) => process.env[k] } as unknown as ConfigService);
    const init = svc.onModuleInit();
    await svc.onModuleDestroy();
    resolveConnect?.();
    await init.catch(() => undefined);

    expect(close).toHaveBeenCalled();
  });
});
