import { buildOpsStatus } from '@fairflow/shared';
import { HealthController } from './health.controller';

describe('HealthController', () => {
  it('healthz always returns ok', () => {
    const controller = new HealthController({} as never, {} as never);
    expect(controller.healthz()).toEqual({ status: 'ok' });
  });

  it('readyz returns 503 when readiness flag is false', async () => {
    const readiness = { isReady: () => false };
    const mongo = { getDb: jest.fn() };
    const controller = new HealthController(mongo as never, readiness as never);
    const reply = { status: jest.fn().mockReturnThis(), send: jest.fn() };
    await controller.readyz(reply as never);
    expect(reply.status).toHaveBeenCalledWith(503);
    expect(reply.send).toHaveBeenCalledWith({ status: 'shutting_down' });
    expect(mongo.getDb).not.toHaveBeenCalled();
  });

  it('readyz pings mongo when ready', async () => {
    const readiness = { isReady: () => true };
    const command = jest.fn().mockResolvedValue({ ok: 1 });
    const mongo = { getDb: () => ({ command }) };
    const controller = new HealthController(mongo as never, readiness as never);
    const reply = { status: jest.fn(), send: jest.fn() };
    await expect(controller.readyz(reply as never)).resolves.toEqual({ status: 'ok' });
    expect(command).toHaveBeenCalledWith({ ping: 1 });
  });

  it('readyz returns error payload when mongo ping fails', async () => {
    const readiness = { isReady: () => true };
    const mongo = {
      getDb: () => ({
        command: jest.fn().mockRejectedValue(new Error('down')),
      }),
    };
    const controller = new HealthController(mongo as never, readiness as never);
    await expect(controller.readyz({} as never)).resolves.toEqual({
      status: 'error',
      message: 'Database not ready',
    });
  });

  it('status exposes the shared ops contract', () => {
    const controller = new HealthController({} as never, {} as never);
    const status = controller.status();
    const expected = buildOpsStatus();
    expect(status.service).toBe(expected.service);
    expect(status.version).toBe(expected.version);
    expect(typeof status.uptimeSec).toBe('number');
  });
});
