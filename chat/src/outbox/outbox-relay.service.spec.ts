const tick = jest.fn();

jest.mock('@fairflow/shared', () => {
  const actual = jest.requireActual('@fairflow/shared');
  return {
    ...actual,
    OutboxRelay: jest.fn().mockImplementation(() => ({
      pollIntervalMs: 5,
      tick,
    })),
  };
});

import { OutboxRelayService } from './outbox-relay.service';
import { MongoOutboxStore } from './mongo-outbox.store';
import { RabbitMqPublisher } from './rabbitmq.publisher';

describe('OutboxRelayService', () => {
  const store = {} as MongoOutboxStore;
  const publisher = {} as RabbitMqPublisher;
  const enabledFlag = process.env.OUTBOX_RELAY_ENABLED;
  let created: OutboxRelayService[] = [];

  beforeEach(() => {
    jest.useFakeTimers();
    tick.mockReset();
    tick.mockResolvedValue({ fetched: 0, published: 0, failed: 0 });
    process.env.OUTBOX_RELAY_ENABLED = 'true';
    created = [];
  });

  afterEach(() => {
    for (const svc of created) svc.onModuleDestroy();
    jest.useRealTimers();
    if (enabledFlag === undefined) delete process.env.OUTBOX_RELAY_ENABLED;
    else process.env.OUTBOX_RELAY_ENABLED = enabledFlag;
  });

  function makeService(): OutboxRelayService {
    const svc = new OutboxRelayService(store, publisher);
    created.push(svc);
    return svc;
  }

  it('не планирует tick при OUTBOX_RELAY_ENABLED=false', () => {
    process.env.OUTBOX_RELAY_ENABLED = 'false';
    const svc = makeService();
    svc.onModuleInit();
    jest.runOnlyPendingTimers();
    expect(tick).not.toHaveBeenCalled();
  });

  it('планирует relay tick после onModuleInit', async () => {
    tick.mockResolvedValueOnce({ fetched: 2, published: 1, failed: 0 });
    const svc = makeService();
    svc.onModuleInit();
    await jest.advanceTimersByTimeAsync(5);
    expect(tick).toHaveBeenCalledTimes(1);
  });

  it('продолжает цикл после ошибки tick', async () => {
    tick.mockRejectedValueOnce(new Error('broker down'));
    tick.mockResolvedValueOnce({ fetched: 0, published: 0, failed: 0 });
    const svc = makeService();
    svc.onModuleInit();
    await jest.advanceTimersByTimeAsync(5);
    await jest.advanceTimersByTimeAsync(5);
    expect(tick).toHaveBeenCalledTimes(2);
  });

  it('onModuleDestroy останавливает таймер', () => {
    const svc = makeService();
    svc.onModuleInit();
    svc.onModuleDestroy();
    jest.runOnlyPendingTimers();
    expect(tick).not.toHaveBeenCalled();
  });
});
