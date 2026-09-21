import { AppConfigService } from '../config/app-config.service';
import { MongoService } from './mongo.service';

type AnyRec = Record<string, unknown>;

function makeService() {
  const config = { databaseUrl: 'mongodb://stub' } as unknown as AppConfigService;
  return new MongoService(config);
}

describe('MongoService public surface', () => {
  it('getDb and getClient throw before connect completes', () => {
    const service = makeService();
    expect(() => service.getDb()).toThrow('MongoDB not connected');
    expect(() => service.getClient()).toThrow('MongoDB not connected');
  });

  it('healthPing delegates to admin().ping()', async () => {
    const ping = jest.fn().mockResolvedValue(undefined);
    const service = makeService();
    (service as unknown as { db: unknown }).db = {
      admin: () => ({ ping }),
    };
    await service.healthPing();
    expect(ping).toHaveBeenCalled();
  });

  it('collection accessors route through getDb()', () => {
    const collection = jest.fn((name: string) => ({ collName: name }));
    const service = makeService();
    (service as unknown as { db: unknown }).db = { collection };
    service.pipelines();
    service.deals();
    service.dealSources();
    service.lostReasons();
    service.dealStageHistory();
    service.outbox();
    service.driftInbox();
    service.idempotencyKeys();
    service.bulkJobs();
    expect(collection).toHaveBeenCalledWith('crm_pipelines');
    expect(collection).toHaveBeenCalledWith('crm_deals');
    expect(collection).toHaveBeenCalledWith('crm_deal_sources');
    expect(collection).toHaveBeenCalledWith('crm_lost_reasons');
    expect(collection).toHaveBeenCalledWith('crm_deal_stage_history');
    expect(collection).toHaveBeenCalledWith('_outbox');
    expect(collection).toHaveBeenCalledWith('crm_drift_inbox');
    expect(collection).toHaveBeenCalledWith('idempotency_keys');
    expect(collection).toHaveBeenCalledWith('crm_bulk_jobs');
  });

  it('onModuleDestroy aborts retry wait and closes the client', async () => {
    const close = jest.fn().mockResolvedValue(undefined);
    const service = makeService();
    (service as unknown as { client: unknown }).client = { close };
    const resolve = jest.fn();
    (service as unknown as { retryResolve: (() => void) | null }).retryResolve = resolve;
    await service.onModuleDestroy();
    expect(resolve).toHaveBeenCalled();
    expect(close).toHaveBeenCalled();
    expect((service as unknown as { destroyed: boolean }).destroyed).toBe(true);
  });
});

describe('MongoService.ensureQueryIndexes', () => {
  it('creates the project-scoped deal lookup indexes best-effort', async () => {
    const commands: AnyRec[] = [];
    const db = {
      command: jest.fn(async (cmd: AnyRec) => {
        commands.push(cmd);
        return { ok: 1 };
      }),
      collection: jest.fn(() => ({
        createIndex: jest.fn(async () => 'ok'),
      })),
    };
    const service = makeService();
    (service as unknown as { db: unknown }).db = db;
    await (service as unknown as { ensureQueryIndexes(): Promise<void> }).ensureQueryIndexes();
    const dealIndexes = commands.filter((c) => c.createIndexes === 'crm_deals');
    expect(dealIndexes.length).toBeGreaterThan(0);
    expect(dealIndexes.some((c) => JSON.stringify(c.indexes).includes('projectId'))).toBe(true);
  });

  it('logs and continues when an index command fails', async () => {
    const db = {
      command: jest.fn(async () => {
        throw new Error('index clash');
      }),
      collection: jest.fn(() => ({
        createIndex: jest.fn(async () => 'ok'),
      })),
    };
    const service = makeService();
    (service as unknown as { db: unknown }).db = db;
    await expect(
      (service as unknown as { ensureQueryIndexes(): Promise<void> }).ensureQueryIndexes(),
    ).resolves.toBeUndefined();
  });
});

describe('MongoService auxiliary index helpers', () => {
  function dbWithCommand() {
    const commands: AnyRec[] = [];
    const createIndex = jest.fn(async () => 'ok');
    const db = {
      command: jest.fn(async (cmd: AnyRec) => {
        commands.push(cmd);
        return { ok: 1 };
      }),
      collection: jest.fn(() => ({ createIndex })),
    };
    return { db, commands, createIndex };
  }

  it('ensureOutboxIndexes creates relay and TTL indexes', async () => {
    const { db, commands } = dbWithCommand();
    const service = makeService();
    (service as unknown as { db: unknown }).db = db;
    await (service as unknown as { ensureOutboxIndexes(): Promise<void> }).ensureOutboxIndexes();
    expect(commands.some((c) => c.createIndexes === '_outbox')).toBe(true);
  });

  it('ensureDriftInboxIndexes creates dedup and TTL indexes', async () => {
    const { db, commands } = dbWithCommand();
    const service = makeService();
    (service as unknown as { db: unknown }).db = db;
    await (
      service as unknown as { ensureDriftInboxIndexes(): Promise<void> }
    ).ensureDriftInboxIndexes();
    expect(commands.some((c) => c.createIndexes === 'crm_drift_inbox')).toBe(true);
  });

  it('ensureIdempotencyIndexes creates project/key unique index', async () => {
    const { db, commands } = dbWithCommand();
    const service = makeService();
    (service as unknown as { db: unknown }).db = db;
    await (
      service as unknown as { ensureIdempotencyIndexes(): Promise<void> }
    ).ensureIdempotencyIndexes();
    expect(commands.some((c) => c.createIndexes === 'idempotency_keys')).toBe(true);
  });

  it('ensureAbacIndexes creates materialized attribute indexes best-effort', async () => {
    const { db, createIndex } = dbWithCommand();
    const service = makeService();
    (service as unknown as { db: unknown }).db = db;
    await (service as unknown as { ensureAbacIndexes(): Promise<void> }).ensureAbacIndexes();
    expect(createIndex).toHaveBeenCalled();
  });

  it('skips index helpers when db is not connected', async () => {
    const service = makeService();
    await expect(
      (service as unknown as { ensureOutboxIndexes(): Promise<void> }).ensureOutboxIndexes(),
    ).resolves.toBeUndefined();
  });
});
