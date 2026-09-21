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

describe('MongoService chat indexes', () => {
  it('ensureIndexes создаёт индексы conversations/members/messages (contracts/chat §9.1)', async () => {
    const indexes: Array<{ collection: string; key: Record<string, unknown>; opts: Record<string, unknown> }> =
      [];
    const db = {
      collection: (name: string) => ({
        createIndex: async (key: Record<string, unknown>, opts: Record<string, unknown>) => {
          indexes.push({ collection: name, key, opts });
          return 'ok';
        },
      }),
    };
    const svc = new MongoService();
    (svc as unknown as { db: unknown }).db = db;
    await (svc as unknown as { ensureIndexes(): Promise<void> }).ensureIndexes();

    const names = indexes.map((i) => `${i.collection}:${String(i.opts.name)}`);
    expect(names).toEqual(
      expect.arrayContaining([
        'conversations:uniq_dm_key',
        'conversations:project_lastMessageAt',
        'conversation_members:uniq_conv_user',
        'messages:conv_seq',
        'messages:uniq_conv_clientMessageId',
        'messages:text_fts',
        'messages:entity_refs_lookup',
      ]),
    );
  });

  it('ensureIndexes не падает при частичных ошибках createIndex', async () => {
    const svc = new MongoService();
    (svc as unknown as { db: unknown }).db = {
      collection: () => ({
        createIndex: async () => {
          throw new Error('index conflict');
        },
      }),
    };
    await expect(
      (svc as unknown as { ensureIndexes(): Promise<void> }).ensureIndexes(),
    ).resolves.toBeUndefined();
  });
});

describe('MongoService lifecycle', () => {
  const prevUri = process.env.MONGODB_URI;

  afterEach(async () => {
    if (prevUri === undefined) delete process.env.MONGODB_URI;
    else process.env.MONGODB_URI = prevUri;
    MongoClientMock.mockReset();
    jest.useRealTimers();
  });

  it('ready() бросает, если onModuleInit не вызывался', async () => {
    const svc = new MongoService();
    await expect(svc.ready()).rejects.toThrow('MongoDB not started');
  });

  it('getDb() бросает до подключения', () => {
    const svc = new MongoService();
    expect(() => svc.getDb()).toThrow('MongoDB not connected yet');
  });

  it('getClient() бросает до подключения', () => {
    const svc = new MongoService();
    expect(() => svc.getClient()).toThrow('MongoDB not connected yet');
  });

  it('onModuleDestroy прерывает backoff wait и закрывает клиент', async () => {
    const svc = new MongoService();
    const close = jest.fn(async () => undefined);
    (svc as unknown as { client: unknown }).client = { close };
    (svc as unknown as { connectPromise: Promise<void> }).connectPromise = Promise.resolve();

    const waitPromise = (svc as unknown as { wait(ms: number): Promise<void> }).wait(60_000);
    await svc.onModuleDestroy();
    await expect(waitPromise).resolves.toBeUndefined();
    expect(close).toHaveBeenCalled();
  });

  it('onModuleInit без MONGODB_URI оставляет connectPromise rejected', async () => {
    delete process.env.MONGODB_URI;
    const svc = new MongoService();
    svc.onModuleInit();
    await expect(svc.ready()).rejects.toThrow('MONGODB_URI is required');
  });

  it('connectWithRetry подключается после transient failure', async () => {
    jest.useFakeTimers();
    process.env.MONGODB_URI = 'mongodb://stub';
    const createIndex = jest.fn(async () => 'ok');
    const collection = jest.fn(() => ({ createIndex }));
    const db = { collection, admin: () => ({ ping: jest.fn() }) };
    const close = jest.fn().mockResolvedValue(undefined);
    const connect = jest.fn().mockRejectedValueOnce(new Error('refused')).mockResolvedValueOnce(undefined);
    const client = { connect, close, db: () => db };
    MongoClientMock.mockImplementation(() => client);

    const svc = new MongoService();
    const init = svc.onModuleInit();
    await jest.runOnlyPendingTimersAsync();
    await init;

    expect(connect).toHaveBeenCalledTimes(2);
    expect(createIndex).toHaveBeenCalled();
    await svc.onModuleDestroy();
  });

  it('connectWithRetry закрывает клиент если destroyed во время connect', async () => {
    process.env.MONGODB_URI = 'mongodb://stub';
    const close = jest.fn().mockResolvedValue(undefined);
    let resolveConnect: () => void = () => undefined;
    const connect = jest.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveConnect = resolve;
        }),
    );
    MongoClientMock.mockImplementation(() => ({ connect, close, db: () => ({ collection: jest.fn() }) }));

    const svc = new MongoService();
    svc.onModuleInit();
    await svc.onModuleDestroy();
    resolveConnect();
    await new Promise((r) => setTimeout(r, 0));

    expect(close).toHaveBeenCalled();
  });

  it('healthPing вызывает admin().ping()', async () => {
    const ping = jest.fn().mockResolvedValue(undefined);
    const svc = new MongoService();
    (svc as unknown as { connectPromise: Promise<void> }).connectPromise = Promise.resolve();
    (svc as unknown as { db: { admin: () => { ping: typeof ping } } }).db = {
      admin: () => ({ ping }),
    };
    await svc.healthPing();
    expect(ping).toHaveBeenCalled();
  });

  it('accessors возвращают ожидаемые имена коллекций', async () => {
    const col = jest.fn().mockReturnValue({});
    const svc = new MongoService();
    (svc as unknown as { connectPromise: Promise<void> }).connectPromise = Promise.resolve();
    (svc as unknown as { db: { collection: typeof col } }).db = { collection: col };

    await svc.conversations();
    await svc.members();
    await svc.messages();
    await svc.outbox();

    expect(col.mock.calls.map((c) => c[0])).toEqual([
      'conversations',
      'conversation_members',
      'messages',
      '_outbox',
    ]);
  });

  it('wait завершается по таймеру без onModuleDestroy', async () => {
    jest.useFakeTimers();
    const svc = new MongoService();
    const waitPromise = (svc as unknown as { wait(ms: number): Promise<void> }).wait(500);
    await jest.advanceTimersByTimeAsync(500);
    await expect(waitPromise).resolves.toBeUndefined();
  });
});
