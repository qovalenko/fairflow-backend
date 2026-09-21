import { HealthController } from './health.controller';

describe('HealthController', () => {
  it('healthz всегда ok', () => {
    const ctrl = new HealthController({ healthPing: jest.fn() } as never);
    expect(ctrl.healthz()).toEqual({ status: 'ok' });
  });

  it('readyz 200 когда mongo отвечает', async () => {
    const mongo = { healthPing: jest.fn().mockResolvedValue(undefined) };
    const ctrl = new HealthController(mongo as never);
    const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };
    await ctrl.readyz(res as never);
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({ status: 'ok' });
  });

  it('readyz 503 когда mongo недоступен', async () => {
    const mongo = { healthPing: jest.fn().mockRejectedValue(new Error('down')) };
    const ctrl = new HealthController(mongo as never);
    const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };
    await ctrl.readyz(res as never);
    expect(res.status).toHaveBeenCalledWith(503);
    expect(res.json).toHaveBeenCalledWith({ status: 'error', message: 'database_not_ready' });
  });

  it('status возвращает buildOpsStatus()', () => {
    const ctrl = new HealthController({ healthPing: jest.fn() } as never);
    const body = ctrl.status();
    expect(body).toMatchObject({ service: expect.any(String), version: expect.any(String) });
  });
});
