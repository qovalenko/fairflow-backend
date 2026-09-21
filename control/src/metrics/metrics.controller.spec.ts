import { OPS_METRICS_CONTENT_TYPE } from '@fairflow/shared';
import { MetricsController } from './metrics.controller';
import type { MetricsService } from './metrics.service';

describe('MetricsController', () => {
  it('returns prometheus text from the metrics service', async () => {
    const metrics = {
      getMetrics: jest.fn().mockResolvedValue('# HELP sample\nsample_metric 1\n'),
    };
    const controller = new MetricsController(metrics as unknown as MetricsService);
    await expect(controller.getMetrics()).resolves.toContain('sample_metric');
    expect(metrics.getMetrics).toHaveBeenCalled();
    expect(OPS_METRICS_CONTENT_TYPE).toContain('text/plain');
  });
});
