import { MetricsController } from './metrics.controller';

describe('MetricsController', () => {
  it('delegates to MetricsService.getMetrics()', async () => {
    const metrics = { getMetrics: jest.fn().mockResolvedValue('# prom\n') };
    const ctrl = new MetricsController(metrics as never);
    await expect(ctrl.getMetrics()).resolves.toBe('# prom\n');
    expect(metrics.getMetrics).toHaveBeenCalled();
  });
});
