import type { Response } from 'express';
import { HealthController } from './health.controller';
import { ReadinessService } from './readiness.service';
import { PrismaService } from '../prisma/prisma.service';

describe('HealthController', () => {
  function build(prismaQuery: jest.Mock, ready = true) {
    const readiness = new ReadinessService();
    readiness.setReady(ready);
    const prisma = { $queryRaw: prismaQuery } as unknown as PrismaService;
    return new HealthController(prisma, readiness);
  }

  it('healthz returns ok', () => {
    const ctl = build(jest.fn());
    expect(ctl.healthz()).toEqual({ status: 'ok' });
  });

  it('readyz returns 503 when the service is shutting down', async () => {
    const ctl = build(jest.fn(), false);
    const res = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn(),
    } as unknown as Response;
    await ctl.readyz(res);
    expect(res.status).toHaveBeenCalledWith(503);
    expect(res.json).toHaveBeenCalledWith({
      status: 'error',
      message: 'service_shutting_down',
    });
  });

  it('readyz returns 200 when the database answers', async () => {
    const ctl = build(jest.fn().mockResolvedValue([{ '?column?': 1 }]));
    const res = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn(),
    } as unknown as Response;
    await ctl.readyz(res);
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({ status: 'ok' });
  });

  it('readyz returns 503 when the database probe fails', async () => {
    const ctl = build(jest.fn().mockRejectedValue(new Error('db down')));
    const res = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn(),
    } as unknown as Response;
    await ctl.readyz(res);
    expect(res.status).toHaveBeenCalledWith(503);
    expect(res.json).toHaveBeenCalledWith({
      status: 'error',
      message: 'database_not_ready',
    });
  });

  it('status exposes buildOpsStatus payload', () => {
    const ctl = build(jest.fn());
    const body = ctl.status();
    expect(body).toEqual(expect.objectContaining({ service: expect.any(String) }));
  });
});
