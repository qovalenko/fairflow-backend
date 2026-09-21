import { HEADERS_METADATA } from '@nestjs/common/constants';
import { OPS_METRICS_CONTENT_TYPE } from '@fairflow/shared';
import { MetricsController } from './metrics.controller';

describe('MetricsController', () => {
  it('returns Prometheus text from MetricsService', async () => {
    const metrics = {
      getMetrics: jest.fn().mockResolvedValue('# HELP documents_operations_total\n'),
    };
    const controller = new MetricsController(metrics as never);
    await expect(controller.getMetrics()).resolves.toContain('documents_operations_total');
    expect(metrics.getMetrics).toHaveBeenCalled();
  });

  it('declares the shared Prometheus Content-Type header on getMetrics', () => {
    const headers = Reflect.getMetadata(
      HEADERS_METADATA,
      MetricsController.prototype.getMetrics,
    ) as Array<{ name: string; value: string }>;
    expect(headers).toEqual(
      expect.arrayContaining([
        { name: 'Content-Type', value: OPS_METRICS_CONTENT_TYPE },
      ]),
    );
  });
});
