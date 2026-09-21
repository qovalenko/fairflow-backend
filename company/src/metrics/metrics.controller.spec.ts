import { MetricsController } from './metrics.controller';

describe('MetricsController', () => {
  it('returns prometheus text from MetricsService', async () => {
    const metrics = { getMetrics: jest.fn().mockResolvedValue('# HELP sample\n') };
    const ctrl = new MetricsController(metrics as never);
    await expect(ctrl.getMetrics()).resolves.toBe('# HELP sample\n');
    expect(metrics.getMetrics).toHaveBeenCalled();
  });
});
