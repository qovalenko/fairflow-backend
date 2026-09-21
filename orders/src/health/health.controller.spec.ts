import { HealthController } from './health.controller';

describe('HealthController', () => {
  it('healthz returns ok', () => {
    const controller = new HealthController({} as never, { isReady: () => true } as never);
    expect(controller.healthz()).toEqual({ status: 'ok' });
  });

  it('readyz returns 503 when shutting down', async () => {
    const reply = { status: jest.fn().mockReturnThis(), send: jest.fn() };
    const controller = new HealthController({} as never, { isReady: () => false } as never);
    await controller.readyz(reply as never);
    expect(reply.status).toHaveBeenCalledWith(503);
    expect(reply.send).toHaveBeenCalledWith({ status: 'shutting_down' });
  });

  it('readyz returns error when mongo ping fails', async () => {
    const mongo = {
      getDb: () => ({ command: jest.fn().mockRejectedValue(new Error('down')) }),
    };
    const controller = new HealthController(mongo as never, { isReady: () => true } as never);
    const reply = { status: jest.fn(), send: jest.fn() };
    const out = await controller.readyz(reply as never);
    expect(out).toEqual({ status: 'error', message: 'Database not ready' });
  });

  it('readyz returns ok when mongo responds', async () => {
    const mongo = {
      getDb: () => ({ command: jest.fn().mockResolvedValue({ ok: 1 }) }),
    };
    const controller = new HealthController(mongo as never, { isReady: () => true } as never);
    const reply = { status: jest.fn(), send: jest.fn() };
    expect(await controller.readyz(reply as never)).toEqual({ status: 'ok' });
  });

  it('status exposes the ops contract payload', () => {
    const controller = new HealthController({} as never, { isReady: () => true } as never);
    const body = controller.status();
    expect(body).toMatchObject({ service: expect.any(String), version: expect.any(String) });
  });
});
