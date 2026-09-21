import { Logger } from '@nestjs/common';
import { ControlOutboxRelayService } from './control-outbox-relay.service';
import { ControlOutboxStore } from './control-outbox.store';
import { ControlRabbitMqPublisher } from './control-rabbitmq.publisher';

describe('ControlOutboxRelayService', () => {
  const prevDisabled = process.env.CONTROL_OUTBOX_DISABLED;

  afterEach(() => {
    if (prevDisabled === undefined) delete process.env.CONTROL_OUTBOX_DISABLED;
    else process.env.CONTROL_OUTBOX_DISABLED = prevDisabled;
    jest.useRealTimers();
  });

  it('does not start the poll timer when CONTROL_OUTBOX_DISABLED=true', () => {
    process.env.CONTROL_OUTBOX_DISABLED = 'true';
    const setIntervalSpy = jest.spyOn(global, 'setInterval');
    const svc = new ControlOutboxRelayService(
      {} as ControlOutboxStore,
      {} as ControlRabbitMqPublisher,
    );
    svc.onModuleInit();
    expect(setIntervalSpy).not.toHaveBeenCalled();
    setIntervalSpy.mockRestore();
  });

  it('runs relay ticks on the configured interval', async () => {
    delete process.env.CONTROL_OUTBOX_DISABLED;
    jest.useFakeTimers();
    const tick = jest.fn().mockResolvedValue({ published: 2, failed: 0 });
    const svc = new ControlOutboxRelayService(
      {} as ControlOutboxStore,
      {} as ControlRabbitMqPublisher,
    );
    (svc as unknown as { relay: { tick: jest.Mock; pollIntervalMs: number } }).relay = {
      tick,
      pollIntervalMs: 1000,
    };

    svc.onModuleInit();
    await jest.advanceTimersByTimeAsync(1000);
    expect(tick).toHaveBeenCalledTimes(1);

    svc.onModuleDestroy();
    await jest.advanceTimersByTimeAsync(3000);
    expect(tick).toHaveBeenCalledTimes(1);
  });

  it('logs relay failures without crashing the timer loop', async () => {
    delete process.env.CONTROL_OUTBOX_DISABLED;
    jest.useFakeTimers();
    const warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const tick = jest.fn().mockResolvedValue({ published: 0, failed: 3 });
    const svc = new ControlOutboxRelayService(
      {} as ControlOutboxStore,
      {} as ControlRabbitMqPublisher,
    );
    (svc as unknown as { relay: { tick: jest.Mock; pollIntervalMs: number } }).relay = {
      tick,
      pollIntervalMs: 500,
    };

    svc.onModuleInit();
    await jest.advanceTimersByTimeAsync(500);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('failed=3'));
    warnSpy.mockRestore();
  });
});
