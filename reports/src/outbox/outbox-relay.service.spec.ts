import { OutboxRelayService } from './outbox-relay.service';

describe('OutboxRelayService', () => {
  const prev = process.env.OUTBOX_RELAY_ENABLED;

  afterEach(() => {
    if (prev === undefined) delete process.env.OUTBOX_RELAY_ENABLED;
    else process.env.OUTBOX_RELAY_ENABLED = prev;
    jest.useRealTimers();
  });

  it('не планирует tick при OUTBOX_RELAY_ENABLED=false', () => {
    process.env.OUTBOX_RELAY_ENABLED = 'false';
    const service = new OutboxRelayService({} as never, {} as never);
    const schedule = jest.spyOn(service as never, 'schedule' as never);
    service.onModuleInit();
    expect(schedule).not.toHaveBeenCalled();
  });

  it('вызывает relay.tick по расписанию и перепланирует', async () => {
    jest.useFakeTimers();
    process.env.OUTBOX_RELAY_ENABLED = 'true';
    const service = new OutboxRelayService({} as never, {} as never);
    const tick = jest.fn().mockResolvedValue({ fetched: 1, published: 1, failed: 0 });
    (service as unknown as { relay: { tick: typeof tick; pollIntervalMs: number } }).relay = {
      tick,
      pollIntervalMs: 1000,
    };
    service.onModuleInit();
    await jest.runOnlyPendingTimersAsync();
    expect(tick).toHaveBeenCalledTimes(1);
    await jest.runOnlyPendingTimersAsync();
    expect(tick).toHaveBeenCalledTimes(2);
    service.onModuleDestroy();
  });

  it('очищает timer на destroy', () => {
    jest.useFakeTimers();
    process.env.OUTBOX_RELAY_ENABLED = 'true';
    const service = new OutboxRelayService({} as never, {} as never);
    (service as unknown as { relay: { tick: jest.Mock; pollIntervalMs: number } }).relay = {
      tick: jest.fn().mockResolvedValue({ fetched: 0, published: 0, failed: 0 }),
      pollIntervalMs: 5000,
    };
    service.onModuleInit();
    service.onModuleDestroy();
    expect((service as unknown as { timer: unknown }).timer).toBeNull();
  });

  it('глотает ошибку tick и продолжает цикл', async () => {
    jest.useFakeTimers();
    process.env.OUTBOX_RELAY_ENABLED = 'true';
    const service = new OutboxRelayService({} as never, {} as never);
    const tick = jest
      .fn()
      .mockRejectedValueOnce(new Error('mongo blip'))
      .mockResolvedValueOnce({ fetched: 0, published: 0, failed: 0 });
    (service as unknown as { relay: { tick: typeof tick; pollIntervalMs: number } }).relay = {
      tick,
      pollIntervalMs: 500,
    };
    service.onModuleInit();
    await jest.runOnlyPendingTimersAsync();
    await jest.runOnlyPendingTimersAsync();
    expect(tick).toHaveBeenCalledTimes(2);
    service.onModuleDestroy();
  });
});
