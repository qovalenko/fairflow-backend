import { OutboxRelay } from '@fairflow/shared';
import { OutboxRelayService } from './outbox-relay.service';
import { MetricsService } from '../metrics/metrics.service';

jest.mock('@fairflow/shared', () => {
  const actual = jest.requireActual('@fairflow/shared');
  return {
    ...actual,
    OutboxRelay: jest.fn(),
  };
});

const OutboxRelayMock = OutboxRelay as jest.Mock;

describe('OutboxRelayService', () => {
  const prevEnabled = process.env.OUTBOX_RELAY_ENABLED;

  afterEach(() => {
    if (prevEnabled === undefined) delete process.env.OUTBOX_RELAY_ENABLED;
    else process.env.OUTBOX_RELAY_ENABLED = prevEnabled;
    jest.clearAllMocks();
  });

  function build(opts?: { tickResult?: { fetched: number; published: number; failed: number } }) {
    const tick = jest
      .fn()
      .mockResolvedValue(opts?.tickResult ?? { fetched: 0, published: 0, failed: 0 });
    OutboxRelayMock.mockImplementation(() => ({
      tick,
      pollIntervalMs: 5,
    }));
    const metrics = {
      recordOutboxRelay: jest.fn(),
    } as unknown as MetricsService;
    const service = new OutboxRelayService({} as never, {} as never, metrics);
    return { service, tick, metrics };
  }

  it('does not schedule ticks when OUTBOX_RELAY_ENABLED=false', () => {
    process.env.OUTBOX_RELAY_ENABLED = 'false';
    const { service } = build();
    service.onModuleInit();
    expect((service as unknown as { timer: NodeJS.Timeout | null }).timer).toBeNull();
  });

  it('records relay metrics and reschedules after a successful tick', async () => {
    process.env.OUTBOX_RELAY_ENABLED = 'true';
    const { service, tick, metrics } = build({
      tickResult: { fetched: 2, published: 1, failed: 1 },
    });
    await (service as unknown as { runOnce(): Promise<void> }).runOnce();
    expect(tick).toHaveBeenCalled();
    expect(metrics.recordOutboxRelay).toHaveBeenCalledWith('fetched', 2);
    expect(metrics.recordOutboxRelay).toHaveBeenCalledWith('published', 1);
    expect(metrics.recordOutboxRelay).toHaveBeenCalledWith('failed', 1);
    service.onModuleDestroy();
  });

  it('swallows tick errors and keeps the loop alive', async () => {
    process.env.OUTBOX_RELAY_ENABLED = 'true';
    const { service, tick } = build();
    tick.mockRejectedValueOnce(new Error('mongo blip'));
    await expect(
      (service as unknown as { runOnce(): Promise<void> }).runOnce(),
    ).resolves.toBeUndefined();
    service.onModuleDestroy();
  });

  it('skips overlapping ticks while one is already running', async () => {
    process.env.OUTBOX_RELAY_ENABLED = 'true';
    const { service, tick } = build();
    let release!: () => void;
    tick.mockImplementation(
      () =>
        new Promise((resolve) => {
          release = () => resolve({ fetched: 0, published: 0, failed: 0 });
        }),
    );
    const first = (service as unknown as { runOnce(): Promise<void> }).runOnce();
    await (service as unknown as { runOnce(): Promise<void> }).runOnce();
    expect(tick).toHaveBeenCalledTimes(1);
    release();
    await first;
    service.onModuleDestroy();
  });

  it('onModuleDestroy clears the relay timer', () => {
    const { service } = build();
    const timer = setTimeout(() => undefined, 60_000);
    (service as unknown as { timer: NodeJS.Timeout | null }).timer = timer;
    service.onModuleDestroy();
    expect((service as unknown as { timer: NodeJS.Timeout | null }).timer).toBeNull();
  });
});
