import { HealthController } from './health.controller';

describe('HealthController', () => {
  it('healthz returns ok without touching dependencies', () => {
    const controller = new HealthController({} as never, {} as never);
    expect(controller.healthz()).toEqual({ status: 'ok' });
  });

  it('readyz returns 503 while shutting down', async () => {
    const readiness = { isReady: () => false };
    const mongo = { getDb: jest.fn() };
    const controller = new HealthController(mongo as never, readiness as never);
    const reply = { status: jest.fn().mockReturnThis(), send: jest.fn() };

    await controller.readyz(reply as never);

    expect(reply.status).toHaveBeenCalledWith(503);
    expect(reply.send).toHaveBeenCalledWith({ status: 'shutting_down' });
    expect(mongo.getDb).not.toHaveBeenCalled();
  });

  it('readyz returns ok when mongo responds to ping', async () => {
    const readiness = { isReady: () => true };
    const mongo = {
      getDb: () => ({ command: jest.fn().mockResolvedValue({ ok: 1 }) }),
    };
    const controller = new HealthController(mongo as never, readiness as never);

    await expect(controller.readyz({} as never)).resolves.toEqual({ status: 'ok' });
  });

  it('readyz returns error payload when mongo ping fails', async () => {
    const readiness = { isReady: () => true };
    const mongo = {
      getDb: () => ({ command: jest.fn().mockRejectedValue(new Error('down')) }),
    };
    const controller = new HealthController(mongo as never, readiness as never);

    await expect(controller.readyz({} as never)).resolves.toEqual({
      status: 'error',
      message: 'Database not ready',
    });
  });

  it('status exposes the shared ops contract', () => {
    const controller = new HealthController({} as never, {} as never);
    const body = controller.status();
    expect(body).toMatchObject({ service: expect.any(String), version: expect.any(String) });
  });
});
