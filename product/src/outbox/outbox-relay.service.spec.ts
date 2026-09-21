import { OutboxRelayService } from './outbox-relay.service';

describe('OutboxRelayService', () => {
  const prev = process.env.OUTBOX_RELAY_ENABLED;

  afterEach(() => {
    if (prev === undefined) delete process.env.OUTBOX_RELAY_ENABLED;
    else process.env.OUTBOX_RELAY_ENABLED = prev;
    jest.useRealTimers();
  });

  it('does not schedule ticks when OUTBOX_RELAY_ENABLED=false', () => {
    process.env.OUTBOX_RELAY_ENABLED = 'false';
    const service = new OutboxRelayService({} as never, {} as never);
    const schedule = jest.spyOn(service as never, 'schedule' as never);
    service.onModuleInit();
    expect(schedule).not.toHaveBeenCalled();
  });

  it('runs relay.tick on schedule and reschedules', async () => {
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

  it('clears the pending timer on destroy', () => {
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

  it('логирует tick с failed>0 и продолжает расписание', async () => {
    jest.useFakeTimers();
    process.env.OUTBOX_RELAY_ENABLED = 'true';
    const service = new OutboxRelayService({} as never, {} as never);
    const tick = jest.fn().mockResolvedValue({ fetched: 2, published: 1, failed: 1 });
    (service as unknown as { relay: { tick: typeof tick; pollIntervalMs: number } }).relay = {
      tick,
      pollIntervalMs: 1000,
    };
    const logSpy = jest.spyOn((service as unknown as { logger: { log: jest.Mock } }).logger, 'log');

    service.onModuleInit();
    await jest.runOnlyPendingTimersAsync();

    expect(logSpy).toHaveBeenCalledWith('outbox tick: fetched=2 published=1 failed=1');
    service.onModuleDestroy();
  });

  it('не падает, когда relay.tick бросает, и планирует следующий tick', async () => {
    jest.useFakeTimers();
    process.env.OUTBOX_RELAY_ENABLED = 'true';
    const service = new OutboxRelayService({} as never, {} as never);
    const tick = jest
      .fn()
      .mockRejectedValueOnce(new Error('mongo blip'))
      .mockResolvedValue({ fetched: 0, published: 0, failed: 0 });
    (service as unknown as { relay: { tick: typeof tick; pollIntervalMs: number } }).relay = {
      tick,
      pollIntervalMs: 1000,
    };

    service.onModuleInit();
    await jest.runOnlyPendingTimersAsync();
    await jest.runOnlyPendingTimersAsync();

    expect(tick).toHaveBeenCalledTimes(2);
    service.onModuleDestroy();
  });

  it('пропускает overlapping tick, пока предыдущий ещё выполняется', async () => {
    jest.useFakeTimers();
    process.env.OUTBOX_RELAY_ENABLED = 'true';
    const service = new OutboxRelayService({} as never, {} as never);
    let resolveTick!: () => void;
    const tick = jest.fn(
      () =>
        new Promise<{ fetched: number; published: number; failed: number }>((resolve) => {
          resolveTick = () => resolve({ fetched: 0, published: 0, failed: 0 });
        }),
    );
    (service as unknown as { relay: { tick: typeof tick; pollIntervalMs: number } }).relay = {
      tick,
      pollIntervalMs: 100,
    };

    service.onModuleInit();
    await jest.runOnlyPendingTimersAsync();
    await jest.runOnlyPendingTimersAsync();
    expect(tick).toHaveBeenCalledTimes(1);

    resolveTick();
    await jest.runOnlyPendingTimersAsync();
    expect(tick).toHaveBeenCalledTimes(2);
    service.onModuleDestroy();
  });
});
