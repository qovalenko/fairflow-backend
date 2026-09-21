import { HealthController } from './health.controller';

describe('HealthController', () => {
  it('healthz always returns ok', () => {
    const mongo = { healthPing: jest.fn() };
    const ctrl = new HealthController(mongo as never);
    expect(ctrl.healthz()).toEqual({ status: 'ok' });
  });

  it('readyz returns 200 when Mongo responds to ping', async () => {
    const mongo = { healthPing: jest.fn().mockResolvedValue(undefined) };
    const ctrl = new HealthController(mongo as never);
    const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };

    await ctrl.readyz(res as never);

    expect(mongo.healthPing).toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({ status: 'ok' });
  });

  it('readyz returns 503 when Mongo ping fails', async () => {
    const mongo = { healthPing: jest.fn().mockRejectedValue(new Error('down')) };
    const ctrl = new HealthController(mongo as never);
    const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };

    await ctrl.readyz(res as never);

    expect(res.status).toHaveBeenCalledWith(503);
    expect(res.json).toHaveBeenCalledWith({ status: 'error', message: 'database_not_ready' });
  });

  it('status exposes the shared ops payload', () => {
    const ctrl = new HealthController({ healthPing: jest.fn() } as never);
    const body = ctrl.status();
    expect(body).toMatchObject({ service: expect.any(String), version: expect.any(String) });
  });
});
