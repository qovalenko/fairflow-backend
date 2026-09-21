import { MongoService } from '../mongo/mongo.service';

describe('FR-COMPANIES-040/160 Mongo TTL indexes', () => {
  it('ensureCompanyIndexes создаёт ttl_purge_at с expireAfterSeconds:0', async () => {
    const created: { key: Record<string, unknown>; opts: Record<string, unknown> }[] = [];
    const coll = {
      createIndex: jest.fn(async (key: Record<string, unknown>, opts: Record<string, unknown>) => {
        created.push({ key, opts });
      }),
      dropIndex: jest.fn(async () => undefined),
    };
    const svc = Object.create(MongoService.prototype) as MongoService;
    (svc as unknown as { db: unknown }).db = {
      collection: (name: string) => {
        if (name === 'companies') return coll;
        if (name === 'company_archives') return coll;
        return coll;
      },
    };
    await (svc as unknown as { ensureCompanyIndexes: () => Promise<void> }).ensureCompanyIndexes();
    const ttl = created.find((c) => c.opts.name === 'ttl_purge_at');
    expect(ttl).toBeDefined();
    expect(ttl!.key).toEqual({ purgeAt: 1 });
    expect(ttl!.opts).toMatchObject({ expireAfterSeconds: 0 });
  });

  it('ensureMergeArchiveIndexes создаёт ttl_expires_at по expiresAt', async () => {
    const created: { key: Record<string, unknown>; opts: Record<string, unknown> }[] = [];
    const coll = {
      createIndex: jest.fn(async (key: Record<string, unknown>, opts: Record<string, unknown>) => {
        created.push({ key, opts });
      }),
    };
    const svc = Object.create(MongoService.prototype) as MongoService;
    (svc as unknown as { db: unknown }).db = { collection: () => coll };
    await (
      svc as unknown as { ensureMergeArchiveIndexes: () => Promise<void> }
    ).ensureMergeArchiveIndexes();
    const ttl = created.find((c) => c.opts.name === 'ttl_expires_at');
    expect(ttl).toBeDefined();
    expect(ttl!.key).toEqual({ expiresAt: 1 });
    expect(ttl!.opts).toMatchObject({ expireAfterSeconds: 0 });
  });
});
