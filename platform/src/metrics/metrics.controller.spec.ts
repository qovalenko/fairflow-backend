import { MetricsController } from './metrics.controller';

describe('MetricsController', () => {
  it('returns prometheus text from the metrics service', async () => {
    const metrics = { getMetrics: jest.fn().mockResolvedValue('# metrics\n') };
    const ctrl = new MetricsController(metrics as never);

    await expect(ctrl.getMetrics()).resolves.toBe('# metrics\n');
    expect(metrics.getMetrics).toHaveBeenCalled();
  });
});
