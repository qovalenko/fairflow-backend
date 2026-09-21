import { HealthController } from './health.controller';
import type { PrismaService } from '../prisma/prisma.service';
import type { ReadinessService } from './readiness.service';

describe('HealthController', () => {
  let prisma: { $queryRaw: jest.Mock };
  let readiness: { isReady: jest.Mock };
  let controller: HealthController;

  beforeEach(() => {
    prisma = { $queryRaw: jest.fn().mockResolvedValue([{ '?column?': 1 }]) };
    readiness = { isReady: jest.fn().mockReturnValue(true) };
    controller = new HealthController(
      prisma as unknown as PrismaService,
      readiness as unknown as ReadinessService,
    );
  });

  it('healthz returns ok without touching dependencies', () => {
    expect(controller.healthz()).toEqual({ status: 'ok' });
    expect(prisma.$queryRaw).not.toHaveBeenCalled();
  });

  it('status returns the shared ops payload', () => {
    const body = controller.status();
    expect(body).toMatchObject({ status: 'ok' });
    expect(body).toHaveProperty('version');
  });

  it('readyz returns 503 when the service is shutting down', async () => {
    readiness.isReady.mockReturnValue(false);
    const send = jest.fn();
    const status = jest.fn().mockReturnValue({ send });
    const reply = { status } as never;
    await controller.readyz(reply);
    expect(status).toHaveBeenCalledWith(503);
    expect(send).toHaveBeenCalledWith({ status: 'error', message: 'service_shutting_down' });
    expect(prisma.$queryRaw).not.toHaveBeenCalled();
  });

  it('readyz returns ok when DB probe succeeds', async () => {
    const send = jest.fn();
    const reply = { send } as never;
    await controller.readyz(reply);
    expect(prisma.$queryRaw).toHaveBeenCalled();
    expect(send).toHaveBeenCalledWith({ status: 'ok' });
  });

  it('readyz returns 503 when DB probe fails', async () => {
    prisma.$queryRaw.mockRejectedValue(new Error('connection refused'));
    const send = jest.fn();
    const status = jest.fn().mockReturnValue({ send });
    const reply = { status } as never;
    await controller.readyz(reply);
    expect(status).toHaveBeenCalledWith(503);
    expect(send).toHaveBeenCalledWith({ status: 'error', message: 'database_not_ready' });
  });
});
