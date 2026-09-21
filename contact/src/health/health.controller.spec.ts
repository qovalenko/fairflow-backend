import { HealthController } from './health.controller';

describe('HealthController', () => {
  function build(ready = true, pingOk = true) {
    const mongo = {
      ready: jest.fn().mockResolvedValue(undefined),
      getDb: jest.fn().mockReturnValue({
        command: pingOk
          ? jest.fn().mockResolvedValue({ ok: 1 })
          : jest.fn().mockRejectedValue(new Error('mongo down')),
      }),
    };
    const readiness = { isReady: () => ready };
    return {
      controller: new HealthController(mongo as never, readiness as never),
      mongo,
    };
  }

  it('healthz returns ok without touching dependencies', () => {
    const { controller } = build();
    expect(controller.healthz()).toEqual({ status: 'ok' });
  });

  it('readyz returns 503 when the service is shutting down', async () => {
    const { controller } = build(false);
    const reply = { status: jest.fn().mockReturnThis(), send: jest.fn() };
    await controller.readyz(reply as never);
    expect(reply.status).toHaveBeenCalledWith(503);
    expect(reply.send).toHaveBeenCalledWith({
      status: 'error',
      message: 'service_shutting_down',
    });
  });

  it('readyz returns ok when mongo answers ping', async () => {
    const { controller, mongo } = build(true, true);
    const reply = { status: jest.fn().mockReturnThis(), send: jest.fn() };
    await controller.readyz(reply as never);
    expect(mongo.ready).toHaveBeenCalled();
    expect(reply.send).toHaveBeenCalledWith({ status: 'ok' });
    expect(reply.status).not.toHaveBeenCalled();
  });

  it('readyz returns 503 when mongo ping fails', async () => {
    const { controller } = build(true, false);
    const reply = { status: jest.fn().mockReturnThis(), send: jest.fn() };
    await controller.readyz(reply as never);
    expect(reply.status).toHaveBeenCalledWith(503);
    expect(reply.send).toHaveBeenCalledWith({
      status: 'error',
      message: 'database_not_ready',
    });
  });

  it('status exposes the shared ops payload', () => {
    const { controller } = build();
    const body = controller.status();
    expect(body).toHaveProperty('service');
    expect(body).toHaveProperty('version');
  });
});
