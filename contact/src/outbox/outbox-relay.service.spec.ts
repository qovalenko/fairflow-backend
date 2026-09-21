const tick = jest.fn(async () => ({ fetched: 0, published: 0, failed: 0 }));

jest.mock('@fairflow/shared', () => {
  const actual = jest.requireActual('@fairflow/shared');
  return {
    ...actual,
    OutboxRelay: jest.fn().mockImplementation(() => ({
      tick,
      pollIntervalMs: 20,
    })),
  };
});

import { Logger } from '@nestjs/common';
import { OutboxRelayService } from './outbox-relay.service';

describe('OutboxRelayService', () => {
  const enabledFlag = process.env.OUTBOX_RELAY_ENABLED;

  afterEach(() => {
    jest.useRealTimers();
    tick.mockReset();
    if (enabledFlag === undefined) delete process.env.OUTBOX_RELAY_ENABLED;
    else process.env.OUTBOX_RELAY_ENABLED = enabledFlag;
  });

  it('does not schedule ticks when disabled', () => {
    jest.useFakeTimers();
    process.env.OUTBOX_RELAY_ENABLED = 'false';
    const svc = new OutboxRelayService({} as never, {} as never);
    svc.onModuleInit();
    jest.advanceTimersByTime(100);
    expect(tick).not.toHaveBeenCalled();
    svc.onModuleDestroy();
  });

  it('runs relay ticks on the poll interval when enabled', async () => {
    jest.useFakeTimers();
    delete process.env.OUTBOX_RELAY_ENABLED;
    tick.mockResolvedValue({ fetched: 2, published: 1, failed: 0 });
    const svc = new OutboxRelayService({} as never, {} as never);
    svc.onModuleInit();
    await jest.advanceTimersByTimeAsync(20);
    expect(tick).toHaveBeenCalledTimes(1);
    svc.onModuleDestroy();
  });

  it('continues polling after a tick failure', async () => {
    jest.useFakeTimers();
    delete process.env.OUTBOX_RELAY_ENABLED;
    tick
      .mockRejectedValueOnce(new Error('mongo down'))
      .mockResolvedValue({ fetched: 0, published: 0, failed: 0 });
    const svc = new OutboxRelayService({} as never, {} as never);
    svc.onModuleInit();
    await jest.advanceTimersByTimeAsync(20);
    await jest.advanceTimersByTimeAsync(20);
    expect(tick).toHaveBeenCalledTimes(2);
    svc.onModuleDestroy();
  });

  it('logs published/failed counts when tick reports activity', async () => {
    jest.useFakeTimers();
    delete process.env.OUTBOX_RELAY_ENABLED;
    const log = jest.spyOn(Logger.prototype, 'log').mockImplementation();
    tick.mockResolvedValue({ fetched: 3, published: 2, failed: 1 });
    const svc = new OutboxRelayService({} as never, {} as never);
    svc.onModuleInit();
    await jest.advanceTimersByTimeAsync(20);
    expect(log).toHaveBeenCalledWith(expect.stringMatching(/fetched=3.*published=2.*failed=1/));
    log.mockRestore();
    svc.onModuleDestroy();
  });
});
