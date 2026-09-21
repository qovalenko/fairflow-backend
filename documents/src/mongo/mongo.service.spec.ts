import { MongoService } from './mongo.service';

type AnyRec = Record<string, unknown>;

function makeService(opts: { dropIndexError?: { code?: number } } = {}) {
  const indexes: Array<{ collection: string; key: AnyRec; opts: AnyRec }> = [];
  const dropped: string[] = [];
  const ping = jest.fn().mockResolvedValue(undefined);

  const collection = (name: string) => ({
    createIndex: async (key: AnyRec, options: AnyRec = {}) => {
      indexes.push({ collection: name, key, opts: options });
      return 'ok';
    },
    dropIndex: async (name: string) => {
      if (opts.dropIndexError) throw opts.dropIndexError;
      dropped.push(name);
    },
  });

  const db = {
    admin: () => ({ ping }),
    collection,
  };

  const config = { get: (key: string) => (key === 'MONGODB_URI' ? 'mongodb://stub' : undefined) };
  const service = new MongoService(config as never);
  (service as unknown as { db: unknown }).db = db;
  (service as unknown as { client: unknown }).client = { close: jest.fn() };
  return { service, indexes, dropped, db, ping };
}

describe('MongoService.ensureIndexes', () => {
  it('creates the core documents indexes and the partial trigger idempotency index', async () => {
    const { service, indexes, dropped } = makeService();
    await (service as unknown as { ensureIndexes(): Promise<void> }).ensureIndexes();

    expect(dropped).toContain(
      'projectId_1_contextType_1_contextRecordId_1_templateId_1_triggerEventId_1',
    );
    const names = indexes.map((i) => (i.opts?.name as string | undefined) ?? JSON.stringify(i.key));
    expect(names).toEqual(
      expect.arrayContaining([
        'trigger_event_idempotency',
        expect.stringContaining('projectId'),
      ]),
    );
    const partial = indexes.find((i) => i.opts.name === 'trigger_event_idempotency');
    expect(partial?.opts).toMatchObject({
      unique: true,
      partialFilterExpression: { triggerEventId: { $exists: true, $type: 'string' } },
    });
  });

  it('continues when the legacy idempotency index is already gone', async () => {
    const { service, indexes } = makeService({ dropIndexError: { code: 27 } });
    await (service as unknown as { ensureIndexes(): Promise<void> }).ensureIndexes();
    expect(indexes.length).toBeGreaterThan(0);
  });
});

describe('MongoService runtime helpers', () => {
  it('healthPing delegates to db.admin().ping()', async () => {
    const { service, ping } = makeService();
    await service.healthPing();
    expect(ping).toHaveBeenCalled();
  });

  it('getClient throws before connect completes', () => {
    const service = new MongoService({ get: () => 'mongodb://stub' } as never);
    expect(() => service.getClient()).toThrow('MongoDB not connected');
  });

  it('collection accessors target the expected Mongo collection names', () => {
    const names: string[] = [];
    const db = {
      admin: () => ({ ping: jest.fn() }),
      collection: (name: string) => {
        names.push(name);
        return { createIndex: async () => 'ok', dropIndex: async () => undefined };
      },
    };
    const service = new MongoService({ get: () => 'mongodb://stub' } as never);
    (service as unknown as { db: unknown }).db = db;
    service.templates();
    service.templateRevisions();
    service.documentGroups();
    service.documentVersions();
    service.outbox();
    expect(names).toEqual([
      'templates',
      'template_revisions',
      'document_groups',
      'document_versions',
      'event_outbox',
    ]);
  });

  it('onModuleDestroy stops an in-flight retry wait and closes the client', async () => {
    jest.useFakeTimers();
    const config = { get: () => 'mongodb://stub' };
    const service = new MongoService(config as never);
    const close = jest.fn().mockResolvedValue(undefined);
    (service as unknown as { client: { close: jest.Mock } }).client = { close };
    const waitPromise = (service as unknown as { wait(ms: number): Promise<void> }).wait(60_000);
    const destroyPromise = service.onModuleDestroy();
    jest.runOnlyPendingTimers();
    await Promise.all([waitPromise, destroyPromise]);
    expect(close).toHaveBeenCalled();
    jest.useRealTimers();
  });
});
