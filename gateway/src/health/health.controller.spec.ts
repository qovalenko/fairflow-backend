import { HealthController } from './health.controller';

describe('HealthController', () => {
  function make(deps?: { ready?: boolean; dbOk?: boolean }) {
    const prisma = {
      $queryRaw:
        deps?.dbOk === false
          ? jest.fn().mockRejectedValue(new Error('down'))
          : jest.fn().mockResolvedValue([{ '?column?': 1 }]),
    };
    const readiness = {
      isReady: jest.fn(() => deps?.ready !== false),
      setReady: jest.fn(),
    };
    const ctrl = new HealthController(prisma as never, readiness as never);
    return { ctrl, prisma, readiness };
  }

  it('healthz returns ok without touching dependencies', () => {
    const { ctrl } = make();
    expect(ctrl.healthz()).toEqual({ status: 'ok' });
  });

  it('status returns the shared ops envelope', () => {
    const { ctrl } = make();
    const body = ctrl.status();
    expect(body.status).toBe('ok');
    expect(typeof body.uptimeSec).toBe('number');
  });

  it('readyz returns 503 when shutting down', async () => {
    const { ctrl } = make({ ready: false });
    const send = jest.fn();
    const status = jest.fn().mockReturnThis();
    await ctrl.readyz({ status, send } as never);
    expect(status).toHaveBeenCalledWith(503);
    expect(send).toHaveBeenCalledWith({ status: 'error', message: 'service_shutting_down' });
  });

  it('readyz returns ok when DB probe succeeds', async () => {
    const { ctrl, prisma } = make();
    const send = jest.fn();
    await ctrl.readyz({ send } as never);
    expect(prisma.$queryRaw).toHaveBeenCalled();
    expect(send).toHaveBeenCalledWith({ status: 'ok' });
  });

  it('readyz returns 503 when DB probe fails', async () => {
    const { ctrl } = make({ dbOk: false });
    const send = jest.fn();
    const status = jest.fn().mockReturnThis();
    await ctrl.readyz({ status, send } as never);
    expect(status).toHaveBeenCalledWith(503);
    expect(send).toHaveBeenCalledWith({ status: 'error', message: 'database_not_ready' });
  });
});
