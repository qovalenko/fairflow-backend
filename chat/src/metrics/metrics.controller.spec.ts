import { HEADERS_METADATA } from '@nestjs/common/constants';
import { OPS_METRICS_CONTENT_TYPE } from '@fairflow/shared';
import { MetricsController } from './metrics.controller';
import { MetricsService } from './metrics.service';

describe('MetricsController', () => {
  it('getMetrics делегирует в MetricsService', async () => {
    const metrics = {
      getMetrics: jest.fn(async () => 'metric_line 1\n'),
    } as unknown as MetricsService;
    const ctrl = new MetricsController(metrics);
    await expect(ctrl.getMetrics()).resolves.toBe('metric_line 1\n');
    expect(metrics.getMetrics).toHaveBeenCalled();
  });

  it('вешает OPS Content-Type на getMetrics', () => {
    expect(Reflect.getMetadata(HEADERS_METADATA, MetricsController.prototype.getMetrics)).toEqual([
      { name: 'Content-Type', value: OPS_METRICS_CONTENT_TYPE },
    ]);
  });
});
