import { OutboxRelayService } from './outbox-relay.service';

describe('OutboxRelayService', () => {
  const relayFlag = process.env.OUTBOX_RELAY_ENABLED;

  afterEach(() => {
    jest.useRealTimers();
    if (relayFlag === undefined) delete process.env.OUTBOX_RELAY_ENABLED;
    else process.env.OUTBOX_RELAY_ENABLED = relayFlag;
  });

  it('does not schedule ticks when OUTBOX_RELAY_ENABLED=false', () => {
    process.env.OUTBOX_RELAY_ENABLED = 'false';
    jest.useFakeTimers();
    const store = { fetchPending: jest.fn() };
    const publisher = { publish: jest.fn() };
    const svc = new OutboxRelayService(store as never, publisher as never);
    svc.onModuleInit();
    jest.runOnlyPendingTimers();
    expect(store.fetchPending).not.toHaveBeenCalled();
    svc.onModuleDestroy();
  });

  it('polls the outbox store on the relay interval when enabled', async () => {
    process.env.OUTBOX_RELAY_ENABLED = 'true';
    jest.useFakeTimers();
    const store = {
      fetchPending: jest.fn().mockResolvedValue([]),
      markPublished: jest.fn(),
      markAttemptFailed: jest.fn(),
    };
    const publisher = { publish: jest.fn() };
    const svc = new OutboxRelayService(store as never, publisher as never);
    svc.onModuleInit();

    await jest.runOnlyPendingTimersAsync();
    expect(store.fetchPending).toHaveBeenCalled();

    svc.onModuleDestroy();
    jest.runOnlyPendingTimers();
    expect(store.fetchPending).toHaveBeenCalledTimes(1);
  });

  it('reschedules after a tick failure without crashing the loop', async () => {
    process.env.OUTBOX_RELAY_ENABLED = 'true';
    jest.useFakeTimers();
    const store = {
      fetchPending: jest.fn().mockRejectedValueOnce(new Error('mongo blip')).mockResolvedValue([]),
      markPublished: jest.fn(),
      markAttemptFailed: jest.fn(),
    };
    const publisher = { publish: jest.fn() };
    const svc = new OutboxRelayService(store as never, publisher as never);
    svc.onModuleInit();

    await jest.runOnlyPendingTimersAsync();
    await jest.runOnlyPendingTimersAsync();
    expect(store.fetchPending).toHaveBeenCalledTimes(2);

    svc.onModuleDestroy();
  });
});
