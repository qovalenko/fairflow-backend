import { ContactDedupIndexError, MongoService } from './mongo.service';

describe('MongoService', () => {
  it('ready() throws when connect was never started', async () => {
    const svc = new MongoService({ databaseUrl: 'mongodb://x/y' } as never);
    await expect(svc.ready()).rejects.toThrow('MongoDB not started');
  });

  it('getDb() throws when not connected yet', () => {
    const svc = new MongoService({ databaseUrl: 'mongodb://x/y' } as never);
    expect(() => svc.getDb()).toThrow('MongoDB not connected yet');
  });

  it('getClient() throws when not connected yet', () => {
    const svc = new MongoService({ databaseUrl: 'mongodb://x/y' } as never);
    expect(() => svc.getClient()).toThrow('MongoDB not connected yet');
  });

  it('onModuleDestroy resolves an in-flight retry wait without hanging', async () => {
    jest.useFakeTimers();
    const svc = new MongoService({ databaseUrl: 'mongodb://invalid' } as never);
    svc.onModuleInit();
    await svc.onModuleDestroy();
    jest.useRealTimers();
  });

  it('ensureOutboxIndexes creates status and TTL indexes', async () => {
    const createIndex = jest.fn(
      async (_key: Record<string, number>, _opts: Record<string, unknown>) => 'ok',
    );
    const svc = new MongoService({ databaseUrl: 'mongodb://x/y' } as never);
    (svc as unknown as { db: unknown }).db = {
      collection: () => ({ createIndex }),
    };
    await (svc as unknown as { ensureOutboxIndexes: () => Promise<void> }).ensureOutboxIndexes();
    const names = createIndex.mock.calls.map((c) => (c[1] as { name?: string })?.name);
    expect(names).toEqual(expect.arrayContaining(['status_created', 'ttl_published']));
  });

  it('ensureIdempotencyIndexes creates unique and TTL indexes', async () => {
    const createIndex = jest.fn(
      async (_key: Record<string, number>, _opts: Record<string, unknown>) => 'ok',
    );
    const svc = new MongoService({ databaseUrl: 'mongodb://x/y' } as never);
    (svc as unknown as { db: unknown }).db = {
      collection: () => ({ createIndex }),
    };
    await (
      svc as unknown as { ensureIdempotencyIndexes: () => Promise<void> }
    ).ensureIdempotencyIndexes();
    const names = createIndex.mock.calls.map((c) => (c[1] as { name?: string })?.name);
    expect(names).toEqual(expect.arrayContaining(['projectId_key_unique', 'ttl_createdAt']));
  });

  it('ensureAbacIndexes is best-effort — one failure does not abort the rest', async () => {
    const createIndex = jest
      .fn()
      .mockRejectedValueOnce(new Error('index clash'))
      .mockResolvedValue('ok');
    const svc = new MongoService({ databaseUrl: 'mongodb://x/y' } as never);
    (svc as unknown as { db: unknown }).db = {
      collection: () => ({ createIndex }),
    };
    await expect(
      (svc as unknown as { ensureAbacIndexes: () => Promise<void> }).ensureAbacIndexes(),
    ).resolves.toBeUndefined();
    expect(createIndex.mock.calls.length).toBeGreaterThan(1);
  });

  it('contacts() waits for ready() then returns the contacts collection', async () => {
    const collection = { find: jest.fn() };
    const svc = new MongoService({ databaseUrl: 'mongodb://x/y' } as never);
    jest.spyOn(svc, 'ready').mockResolvedValue(undefined);
    jest.spyOn(svc, 'getDb').mockReturnValue({
      collection: (name: string) => {
        expect(name).toBe('contacts');
        return collection;
      },
    } as never);
    await expect(svc.contacts()).resolves.toBe(collection);
  });

  it('idempotencyKeys() и outbox() возвращают именованные коллекции', async () => {
    const idempotencyColl = { find: jest.fn() };
    const outboxColl = { find: jest.fn() };
    const svc = new MongoService({ databaseUrl: 'mongodb://x/y' } as never);
    jest.spyOn(svc, 'ready').mockResolvedValue(undefined);
    jest.spyOn(svc, 'getDb').mockReturnValue({
      collection: (name: string) => {
        if (name === 'idempotency_keys') return idempotencyColl;
        if (name === '_outbox') return outboxColl;
        throw new Error(`unexpected ${name}`);
      },
    } as never);
    await expect(svc.idempotencyKeys()).resolves.toBe(idempotencyColl);
    await expect(svc.outbox()).resolves.toBe(outboxColl);
  });

  it('ContactDedupIndexError несёт имя индекса', () => {
    const err = new ContactDedupIndexError('dedup_email', 'duplicate key');
    expect(err.name).toBe('ContactDedupIndexError');
    expect(err.indexName).toBe('dedup_email');
    expect(err.message).toBe('duplicate key');
  });

  it('ensureContactIndexes бросает ContactDedupIndexError при сбое уникального dedup-индекса', async () => {
    const createIndex = jest
      .fn()
      .mockResolvedValueOnce('ok')
      .mockRejectedValueOnce(new Error('E11000 duplicate'));
    const svc = new MongoService({ databaseUrl: 'mongodb://x/y' } as never);
    (svc as unknown as { db: unknown }).db = {
      collection: () => ({ createIndex }),
    };
    await expect(
      (svc as unknown as { ensureContactIndexes: () => Promise<void> }).ensureContactIndexes(),
    ).rejects.toBeInstanceOf(ContactDedupIndexError);
  });
});
