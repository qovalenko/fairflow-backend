import { MetricsController } from './metrics.controller';

describe('MetricsController', () => {
  it('returns prometheus text from MetricsService', async () => {
    const metrics = { getMetrics: jest.fn(async () => '# HELP ok\n') };
    const controller = new MetricsController(metrics as never);
    await expect(controller.getMetrics()).resolves.toBe('# HELP ok\n');
    expect(metrics.getMetrics).toHaveBeenCalledTimes(1);
  });
});
