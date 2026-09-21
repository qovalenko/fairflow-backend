import { SearchHealthController } from './search-health.controller';

describe('SearchHealthController', () => {
  it('healthz returns ok', () => {
    const ctrl = new SearchHealthController({} as never);
    expect(ctrl.healthz()).toEqual({ status: 'ok' });
  });

  it('readyz returns 200 when mongo responds to ping', async () => {
    const mongo = { healthPing: jest.fn().mockResolvedValue(undefined) };
    const ctrl = new SearchHealthController(mongo as never);
    const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };

    await ctrl.readyz(res as never);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({ status: 'ok' });
  });

  it('readyz returns 503 when mongo ping fails', async () => {
    const mongo = { healthPing: jest.fn().mockRejectedValue(new Error('down')) };
    const ctrl = new SearchHealthController(mongo as never);
    const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };

    await ctrl.readyz(res as never);

    expect(res.status).toHaveBeenCalledWith(503);
    expect(res.json).toHaveBeenCalledWith({ status: 'error', message: 'database_not_ready' });
  });

  it('status exposes the shared ops payload', () => {
    const ctrl = new SearchHealthController({} as never);
    expect(ctrl.status()).toMatchObject({
      status: 'ok',
      service: expect.any(String),
      version: expect.any(String),
      timestamp: expect.any(String),
    });
  });
});
