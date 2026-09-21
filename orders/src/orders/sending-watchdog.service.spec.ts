import { SendingWatchdogService } from './sending-watchdog.service';
import type { OrdersService } from './orders.service';

describe('SendingWatchdogService (operational exit from SENDING)', () => {
  it('sweep drives OrdersService.expireStaleSending with the stale budget', async () => {
    const expireStaleSending = jest.fn(async () => 2);
    const watchdog = new SendingWatchdogService({
      expireStaleSending,
    } as unknown as OrdersService);
    await watchdog.sweep();
    expect(expireStaleSending).toHaveBeenCalledTimes(1);
    // Default budget must exceed the automation delivery worst case
    // (4 deliveries over the 30s/60s/300s ladder ≈ 6.5 min + execution timeouts).
    const [staleAfterMs] = expireStaleSending.mock.calls[0] as unknown as [number];
    expect(staleAfterMs).toBeGreaterThanOrEqual(10 * 60 * 1000);
  });

  it('a sweep failure never escapes (the interval must survive)', async () => {
    const watchdog = new SendingWatchdogService({
      expireStaleSending: jest.fn(async () => {
        throw new Error('mongo down');
      }),
    } as unknown as OrdersService);
    await expect(watchdog.sweep()).resolves.toBeUndefined();
  });

  it('onModuleInit не запускает интервал при ORDERS_SENDING_WATCHDOG_ENABLED=false', () => {
    const prev = process.env.ORDERS_SENDING_WATCHDOG_ENABLED;
    process.env.ORDERS_SENDING_WATCHDOG_ENABLED = 'false';
    jest.useFakeTimers();
    const expireStaleSending = jest.fn(async () => 0);
    const watchdog = new SendingWatchdogService({
      expireStaleSending,
    } as unknown as OrdersService);
    watchdog.onModuleInit();
    jest.runOnlyPendingTimers();
    expect(expireStaleSending).not.toHaveBeenCalled();
    watchdog.onModuleDestroy();
    jest.useRealTimers();
    if (prev === undefined) delete process.env.ORDERS_SENDING_WATCHDOG_ENABLED;
    else process.env.ORDERS_SENDING_WATCHDOG_ENABLED = prev;
  });

  it('onModuleInit запускает sweep по интервалу и onModuleDestroy его останавливает', async () => {
    const prev = process.env.ORDERS_SENDING_WATCHDOG_ENABLED;
    const prevInterval = process.env.ORDERS_SENDING_SWEEP_INTERVAL_MS;
    process.env.ORDERS_SENDING_WATCHDOG_ENABLED = 'true';
    process.env.ORDERS_SENDING_SWEEP_INTERVAL_MS = '1000';
    jest.useFakeTimers();
    const expireStaleSending = jest.fn(async () => 0);
    const watchdog = new SendingWatchdogService({
      expireStaleSending,
    } as unknown as OrdersService);
    watchdog.onModuleInit();
    await jest.advanceTimersByTimeAsync(1000);
    expect(expireStaleSending).toHaveBeenCalledTimes(1);
    watchdog.onModuleDestroy();
    await jest.advanceTimersByTimeAsync(5000);
    expect(expireStaleSending).toHaveBeenCalledTimes(1);
    jest.useRealTimers();
    if (prev === undefined) delete process.env.ORDERS_SENDING_WATCHDOG_ENABLED;
    else process.env.ORDERS_SENDING_WATCHDOG_ENABLED = prev;
    if (prevInterval === undefined) delete process.env.ORDERS_SENDING_SWEEP_INTERVAL_MS;
    else process.env.ORDERS_SENDING_SWEEP_INTERVAL_MS = prevInterval;
  });
});
