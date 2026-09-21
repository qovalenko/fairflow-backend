import { HealthController } from './health.controller';

describe('HealthController', () => {
  it('healthz always returns ok', () => {
    const controller = new HealthController({} as never, { isReady: () => true } as never);
    expect(controller.healthz()).toEqual({ status: 'ok' });
  });

  it('readyz returns 503 when the service is shutting down', async () => {
    const controller = new HealthController(
      { getDb: jest.fn() } as never,
      {
        isReady: () => false,
      } as never,
    );
    const reply = { status: jest.fn().mockReturnThis(), send: jest.fn() };
    await controller.readyz(reply as never);
    expect(reply.status).toHaveBeenCalledWith(503);
    expect(reply.send).toHaveBeenCalledWith({ status: 'shutting_down' });
  });

  it('readyz returns ok when mongo ping succeeds', async () => {
    const command = jest.fn().mockResolvedValue({ ok: 1 });
    const controller = new HealthController(
      { getDb: () => ({ command }) } as never,
      { isReady: () => true } as never,
    );
    await expect(controller.readyz({} as never)).resolves.toEqual({ status: 'ok' });
    expect(command).toHaveBeenCalledWith({ ping: 1 });
  });

  it('readyz returns error when mongo ping fails', async () => {
    const command = jest.fn().mockRejectedValue(new Error('down'));
    const controller = new HealthController(
      { getDb: () => ({ command }) } as never,
      { isReady: () => true } as never,
    );
    await expect(controller.readyz({} as never)).resolves.toEqual({
      status: 'error',
      message: 'Database not ready',
    });
  });

  it('status returns the shared ops status payload', () => {
    const controller = new HealthController({} as never, {} as never);
    expect(controller.status()).toMatchObject({
      service: 'fairflow-pipe',
      status: 'ok',
      version: '1.0.0',
    });
    expect(controller.status().timestamp).toEqual(expect.any(String));
  });
});
