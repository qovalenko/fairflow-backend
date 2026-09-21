const tick = jest.fn().mockResolvedValue({ fetched: 0, published: 0, failed: 0 });

jest.mock('@fairflow/shared', () => {
  const actual = jest.requireActual('@fairflow/shared');
  return {
    ...actual,
    OutboxRelay: jest.fn().mockImplementation(() => ({
      pollIntervalMs: 10,
      tick,
    })),
  };
});

import { OutboxRelayService } from './outbox-relay.service';

describe('OutboxRelayService', () => {
  const prev = process.env.OUTBOX_RELAY_ENABLED;

  afterEach(() => {
    jest.useRealTimers();
    tick.mockClear();
    if (prev === undefined) delete process.env.OUTBOX_RELAY_ENABLED;
    else process.env.OUTBOX_RELAY_ENABLED = prev;
  });

  it('does not schedule ticks when OUTBOX_RELAY_ENABLED=false', () => {
    process.env.OUTBOX_RELAY_ENABLED = 'false';
    const spy = jest.spyOn(global, 'setTimeout');
    const svc = new OutboxRelayService({} as never, {} as never);
    svc.onModuleInit();
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it('runs relay ticks on the poll interval when enabled', async () => {
    jest.useFakeTimers();
    process.env.OUTBOX_RELAY_ENABLED = 'true';
    tick.mockResolvedValueOnce({ fetched: 2, published: 1, failed: 0 });
    const svc = new OutboxRelayService({} as never, {} as never);
    svc.onModuleInit();
    await jest.runOnlyPendingTimersAsync();
    expect(tick).toHaveBeenCalled();
    svc.onModuleDestroy();
  });

  it('clears the scheduled timer on destroy', () => {
    jest.useFakeTimers();
    process.env.OUTBOX_RELAY_ENABLED = 'true';
    const svc = new OutboxRelayService({} as never, {} as never);
    svc.onModuleInit();
    svc.onModuleDestroy();
    const callsBefore = tick.mock.calls.length;
    jest.runOnlyPendingTimers();
    expect(tick.mock.calls.length).toBe(callsBefore);
  });
});
