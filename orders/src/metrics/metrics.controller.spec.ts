import { MetricsController } from './metrics.controller';

describe('MetricsController', () => {
  it('returns prometheus text from the metrics service', async () => {
    const metrics = { getMetrics: jest.fn().mockResolvedValue('# HELP ok\nok 1\n') };
    const controller = new MetricsController(metrics as never);
    await expect(controller.getMetrics()).resolves.toBe('# HELP ok\nok 1\n');
    expect(metrics.getMetrics).toHaveBeenCalledTimes(1);
  });
});
