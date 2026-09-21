import { HealthController } from './health.controller';

describe('HealthController readyz', () => {
  const consumerFlag = process.env.NOTIFICATION_CONSUMER_ENABLED;

  afterAll(() => {
    if (consumerFlag === undefined) delete process.env.NOTIFICATION_CONSUMER_ENABLED;
    else process.env.NOTIFICATION_CONSUMER_ENABLED = consumerFlag;
  });

  it('returns 503 when consumer enabled but broker not bound', async () => {
    process.env.NOTIFICATION_CONSUMER_ENABLED = 'true';
    const mongo = { healthPing: jest.fn().mockResolvedValue(undefined) };
    const rabbit = { bound: false };
    const controller = new HealthController(mongo as never, rabbit as never);
    const res = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn(),
    };
    await controller.readyz(res as never);
    expect(res.status).toHaveBeenCalledWith(503);
    expect(res.json).toHaveBeenCalledWith({ status: 'error', message: 'consumer_not_bound' });
  });

  it('returns 200 when mongo is up and consumer is bound', async () => {
    process.env.NOTIFICATION_CONSUMER_ENABLED = 'true';
    const mongo = { healthPing: jest.fn().mockResolvedValue(undefined) };
    const rabbit = { bound: true };
    const controller = new HealthController(mongo as never, rabbit as never);
    const res = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn(),
    };
    await controller.readyz(res as never);
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({ status: 'ok' });
  });
});
