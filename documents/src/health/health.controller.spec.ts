import { HealthController } from './health.controller';

describe('HealthController', () => {
  it('healthz always returns ok', () => {
    const controller = new HealthController({ healthPing: jest.fn() } as never);
    expect(controller.healthz()).toEqual({ status: 'ok' });
  });

  it('readyz returns 200 when Mongo responds to ping', async () => {
    const mongo = { healthPing: jest.fn().mockResolvedValue(undefined) };
    const controller = new HealthController(mongo as never);
    const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };
    await controller.readyz(res as never);
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({ status: 'ok' });
  });

  it('readyz returns 503 when Mongo ping fails', async () => {
    const mongo = { healthPing: jest.fn().mockRejectedValue(new Error('down')) };
    const controller = new HealthController(mongo as never);
    const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };
    await controller.readyz(res as never);
    expect(res.status).toHaveBeenCalledWith(503);
    expect(res.json).toHaveBeenCalledWith({ status: 'error', message: 'database_not_ready' });
  });

  it('status exposes the shared ops contract payload', () => {
    const controller = new HealthController({ healthPing: jest.fn() } as never);
    const body = controller.status();
    expect(body).toMatchObject({ service: expect.any(String), version: expect.any(String) });
  });
});
