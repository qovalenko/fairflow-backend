import { MetricsController } from './metrics.controller';

describe('MetricsController', () => {
  it('returns Prometheus text from MetricsService', async () => {
    const metrics = { getMetrics: jest.fn().mockResolvedValue('pipe_outbox_relay_total 1') };
    const controller = new MetricsController(metrics as never);
    await expect(controller.getMetrics()).resolves.toBe('pipe_outbox_relay_total 1');
    expect(metrics.getMetrics).toHaveBeenCalled();
  });
});
