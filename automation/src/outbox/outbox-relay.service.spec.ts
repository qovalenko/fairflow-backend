import { AutomationOutboxRelayService } from './outbox-relay.service';

describe('AutomationOutboxRelayService', () => {
  const enabledFlag = process.env.AUTOMATION_OUTBOX_RELAY_ENABLED;
  const pollFlag = process.env.AUTOMATION_OUTBOX_POLL_MS;

  afterEach(() => {
    jest.useRealTimers();
    if (enabledFlag === undefined) delete process.env.AUTOMATION_OUTBOX_RELAY_ENABLED;
    else process.env.AUTOMATION_OUTBOX_RELAY_ENABLED = enabledFlag;
    if (pollFlag === undefined) delete process.env.AUTOMATION_OUTBOX_POLL_MS;
    else process.env.AUTOMATION_OUTBOX_POLL_MS = pollFlag;
  });

  it('does not schedule ticks when disabled', () => {
    jest.useFakeTimers();
    process.env.AUTOMATION_OUTBOX_RELAY_ENABLED = 'false';
    const store = { fetchPending: jest.fn(async () => []) };
    const publisher = { publish: jest.fn() };
    const svc = new AutomationOutboxRelayService(store as never, publisher as never);
    svc.onModuleInit();
    jest.advanceTimersByTime(100);
    expect(store.fetchPending).not.toHaveBeenCalled();
    svc.onModuleDestroy();
  });

  it('runs relay ticks on the poll interval', async () => {
    jest.useFakeTimers();
    process.env.AUTOMATION_OUTBOX_RELAY_ENABLED = 'true';
    process.env.AUTOMATION_OUTBOX_POLL_MS = '20';
    const store = {
      fetchPending: jest.fn(async () => [
        { messageId: 'm1', envelope: { type: 'automation.test' } },
      ]),
      markPublished: jest.fn(async () => undefined),
    };
    const publisher = { publish: jest.fn(async () => undefined) };
    const svc = new AutomationOutboxRelayService(store as never, publisher as never);
    svc.onModuleInit();
    await jest.advanceTimersByTimeAsync(20);
    expect(store.fetchPending).toHaveBeenCalled();
    expect(publisher.publish).toHaveBeenCalledWith({ type: 'automation.test' });
    expect(store.markPublished).toHaveBeenCalledWith('m1', expect.any(Date));
    svc.onModuleDestroy();
  });

  it('continues polling after a tick failure', async () => {
    jest.useFakeTimers();
    process.env.AUTOMATION_OUTBOX_RELAY_ENABLED = 'true';
    process.env.AUTOMATION_OUTBOX_POLL_MS = '20';
    const store = {
      fetchPending: jest
        .fn()
        .mockRejectedValueOnce(new Error('mongo down'))
        .mockResolvedValue([]),
    };
    const publisher = { publish: jest.fn() };
    const svc = new AutomationOutboxRelayService(store as never, publisher as never);
    svc.onModuleInit();
    await jest.advanceTimersByTimeAsync(20);
    await jest.advanceTimersByTimeAsync(20);
    expect(store.fetchPending).toHaveBeenCalledTimes(2);
    svc.onModuleDestroy();
  });
});
