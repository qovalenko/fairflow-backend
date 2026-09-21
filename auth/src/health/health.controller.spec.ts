import { HealthController } from './health.controller';

describe('HealthController ops endpoints', () => {
  it('healthz returns ok without touching the database', () => {
    const c = new HealthController({} as never);
    expect(c.healthz()).toEqual({ status: 'ok' });
  });

  it('readyz returns 200 when the database answers SELECT 1', async () => {
    const prisma = { $queryRaw: jest.fn().mockResolvedValue([{ '?column?': 1 }]) };
    const reply = { status: jest.fn().mockReturnThis(), send: jest.fn() };
    const c = new HealthController(prisma as never);
    await c.readyz(reply as never);
    expect(prisma.$queryRaw).toHaveBeenCalled();
    expect(reply.status).not.toHaveBeenCalled();
    expect(reply.send).toHaveBeenCalledWith({ status: 'ok' });
  });

  it('readyz returns 503 database_not_ready when the DB probe fails', async () => {
    const prisma = { $queryRaw: jest.fn().mockRejectedValue(new Error('connection refused')) };
    const reply = { status: jest.fn().mockReturnThis(), send: jest.fn() };
    const c = new HealthController(prisma as never);
    await c.readyz(reply as never);
    expect(reply.status).toHaveBeenCalledWith(503);
    expect(reply.send).toHaveBeenCalledWith({ status: 'error', message: 'database_not_ready' });
  });

  it('status returns the shared ops status payload', () => {
    const c = new HealthController({} as never);
    const body = c.status();
    expect(body).toEqual(
      expect.objectContaining({
        status: 'ok',
        service: 'fairflow-auth-service',
      }),
    );
  });
});
