import { OutboxRelayService } from './outbox-relay.service';
import { MongoOutboxStore } from './mongo-outbox.store';
import { RabbitMqPublisher } from './rabbitmq.publisher';

describe('OutboxRelayService', () => {
  const prevEnabled = process.env.OUTBOX_RELAY_ENABLED;
  let active: OutboxRelayService | undefined;

  beforeEach(() => {
    process.env.OUTBOX_RELAY_ENABLED = 'false';
  });

  afterEach(() => {
    active?.onModuleDestroy();
    active = undefined;
    jest.useRealTimers();
    if (prevEnabled === undefined) delete process.env.OUTBOX_RELAY_ENABLED;
    else process.env.OUTBOX_RELAY_ENABLED = prevEnabled;
  });

  function makeService() {
    const store = {
      requeueStaleFailed: jest.fn().mockResolvedValue(0),
    } as unknown as MongoOutboxStore;
    const publisher = {} as RabbitMqPublisher;
    const svc = new OutboxRelayService(store, publisher);
    (svc as unknown as { relay: { tick: jest.Mock; pollIntervalMs: number } }).relay = {
      tick: jest.fn().mockResolvedValue({ fetched: 0, published: 0, failed: 0 }),
      pollIntervalMs: 50,
    };
    return { svc, store };
  }

  it('does not schedule ticks when OUTBOX_RELAY_ENABLED=false', () => {
    const { svc } = makeService();
    active = svc;
    svc.onModuleInit();
    expect((svc as unknown as { timer: NodeJS.Timeout | null }).timer).toBeNull();
  });

  it('runOnce requeues stale failed rows then ticks the relay', async () => {
    const { svc, store } = makeService();
    active = svc;
    (store.requeueStaleFailed as jest.Mock).mockResolvedValue(2);
    (svc as unknown as { relay: { tick: jest.Mock } }).relay.tick.mockResolvedValue({
      fetched: 1,
      published: 1,
      failed: 0,
    });

    await (svc as unknown as { runOnce: () => Promise<void> }).runOnce();

    expect(store.requeueStaleFailed).toHaveBeenCalled();
    expect((svc as unknown as { relay: { tick: jest.Mock } }).relay.tick).toHaveBeenCalled();
  });

  it('swallows tick errors and keeps the loop alive', async () => {
    const { svc } = makeService();
    active = svc;
    (svc as unknown as { relay: { tick: jest.Mock } }).relay.tick.mockRejectedValue(
      new Error('broker down'),
    );

    await expect(
      (svc as unknown as { runOnce: () => Promise<void> }).runOnce(),
    ).resolves.toBeUndefined();
  });

  it('onModuleDestroy clears the scheduled timer', () => {
    const { svc } = makeService();
    active = svc;
    const timer = setTimeout(() => undefined, 10_000);
    (svc as unknown as { timer: NodeJS.Timeout | null }).timer = timer;
    svc.onModuleDestroy();
    expect((svc as unknown as { timer: NodeJS.Timeout | null }).timer).toBeNull();
  });
});
