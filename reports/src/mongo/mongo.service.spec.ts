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

  it('onModuleInit бросает если MONGODB_URI не задан', async () => {
    delete process.env.MONGODB_URI;
    const svc = new MongoService({ get: () => undefined } as never);
    await expect(svc.onModuleInit()).rejects.toThrow('MONGODB_URI is required');
  });

  it('healthPing вызывает admin().ping()', async () => {
    const ping = jest.fn().mockResolvedValue(undefined);
    const svc = new MongoService({ get: () => 'mongodb://stub' } as never);
    (svc as unknown as { db: { admin: () => { ping: typeof ping } } }).db = {
      admin: () => ({ ping }),
    };
    await svc.healthPing();
    expect(ping).toHaveBeenCalled();
  });

  it('accessors возвращают ожидаемые имена коллекций', () => {
    const col = jest.fn().mockReturnValue({});
    const svc = new MongoService({ get: () => 'mongodb://stub' } as never);
    (svc as unknown as { db: { collection: typeof col } }).db = { collection: col };

    svc.reports();
    svc.deals();
    svc.orders();
    svc.contacts();
    svc.companies();
    svc.activities();
    svc.statisticsRollup();
    svc.statisticsRollupMsgs();
    svc.statisticsRollupState();
    svc.stageTransitions();
    svc.outbox();

    expect(col.mock.calls.map((c) => c[0])).toEqual([
      'reports_definitions',
      'crm_deals',
      'crm_orders',
      'contacts',
      'companies',
      'crm_activities',
      'statistics_rollup',
      'statistics_rollup_msgs',
      'statistics_rollup_state',
      'stage_transitions',
      '_outbox',
    ]);
  });

  it('connectWithRetry подключается после transient failure', async () => {
    jest.useFakeTimers();
    process.env.MONGODB_URI = 'mongodb://stub';
    const close = jest.fn().mockResolvedValue(undefined);
    const connect = jest.fn().mockRejectedValueOnce(new Error('refused')).mockResolvedValueOnce(undefined);
    const client = { connect, close, db: () => ({}) };
    MongoClientMock.mockImplementation(() => client);

    const svc = new MongoService({ get: (k: string) => process.env[k] } as never);
    const init = svc.onModuleInit();
    await jest.runOnlyPendingTimersAsync();
    await init;

    expect(connect).toHaveBeenCalledTimes(2);
    await svc.onModuleDestroy();
  });

  it('onModuleDestroy прерывает backoff-wait', async () => {
    jest.useFakeTimers();
    process.env.MONGODB_URI = 'mongodb://stub';
    const close = jest.fn().mockResolvedValue(undefined);
    MongoClientMock.mockImplementation(() => ({
      connect: jest.fn().mockRejectedValue(new Error('down')),
      close,
      db: () => ({}),
    }));

    const svc = new MongoService({ get: (k: string) => process.env[k] } as never);
    const init = svc.onModuleInit();
    await svc.onModuleDestroy();
    await jest.runOnlyPendingTimersAsync();
    await init.catch(() => undefined);

    expect(close).toHaveBeenCalled();
  });
});
