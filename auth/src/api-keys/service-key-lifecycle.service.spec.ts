import { ServiceKeyLifecycleService } from './service-key-lifecycle.service';
import type { ApiKeysService } from './api-keys.service';
import type { AuthBusPublisherService } from '../auth/auth-bus-publisher.service';

describe('ServiceKeyLifecycleService (FR-AUTH-370)', () => {
  const make = () => {
    const apiKeys = {
      findExpiringWithin: jest.fn().mockResolvedValue([
        {
          id: 'k1',
          name: 'Gateway',
          keyPrefix: 'ak_deadbeef',
          expiresAt: new Date('2026-09-01T00:00:00.000Z'),
        },
      ]),
      findExpiredActive: jest.fn().mockResolvedValue([]),
    } as unknown as ApiKeysService;
    const bus = {
      publish: jest.fn().mockResolvedValue(undefined),
    } as unknown as AuthBusPublisherService;
    const svc = new ServiceKeyLifecycleService(apiKeys, bus);
    return { svc, apiKeys, bus };
  };

  it('publishes expiring-key alert once per sweep', async () => {
    const { svc, bus } = make();
    const first = await svc.runSweep();
    expect(first.expiring).toBe(1);
    expect(bus.publish).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'auth.service_key.expiring',
        payload: expect.objectContaining({ keyId: 'k1' }),
      }),
    );
    const calls = (bus.publish as jest.Mock).mock.calls.length;
    await svc.runSweep();
    expect((bus.publish as jest.Mock).mock.calls.length).toBe(calls);
  });

  it('publishes expired-key alert and deduplicates on repeat', async () => {
    const { svc, apiKeys, bus } = make();
    (apiKeys.findExpiringWithin as jest.Mock).mockResolvedValue([]);
    (apiKeys.findExpiredActive as jest.Mock).mockResolvedValue([
      {
        id: 'k-exp',
        name: 'Stale',
        keyPrefix: 'ak_expired',
        expiresAt: new Date('2026-01-01T00:00:00.000Z'),
      },
    ]);
    const first = await svc.runSweep();
    expect(first.expired).toBe(1);
    expect(bus.publish).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'auth.service_key.expired',
        payload: expect.objectContaining({ keyId: 'k-exp' }),
      }),
    );
    const calls = (bus.publish as jest.Mock).mock.calls.length;
    await svc.runSweep();
    expect((bus.publish as jest.Mock).mock.calls.length).toBe(calls);
  });

  it('alertDays falls back to 14 for invalid env', () => {
    process.env.SERVICE_KEY_ALERT_DAYS = 'not-a-number';
    const { svc } = make();
    expect(svc.alertDays()).toBe(14);
    delete process.env.SERVICE_KEY_ALERT_DAYS;
  });

  it('onModuleInit skips timer when sweep interval is disabled', () => {
    process.env.SERVICE_KEY_SWEEP_MS = '0';
    const { svc } = make();
    svc.onModuleInit();
    expect((svc as unknown as { timer: unknown }).timer).toBeNull();
    delete process.env.SERVICE_KEY_SWEEP_MS;
  });

  it('onModuleDestroy clears the sweep timer', () => {
    const { svc } = make();
    const clearIntervalSpy = jest.spyOn(globalThis, 'clearInterval');
    (svc as unknown as { timer: ReturnType<typeof setInterval> }).timer = setInterval(
      () => undefined,
      60_000,
    );
    svc.onModuleDestroy();
    expect(clearIntervalSpy).toHaveBeenCalled();
    clearIntervalSpy.mockRestore();
  });
});
