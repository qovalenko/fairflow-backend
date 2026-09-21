import { HEADERS_METADATA } from '@nestjs/common/constants';
import { OPS_METRICS_CONTENT_TYPE } from '@fairflow/shared';
import { MetricsController } from './metrics.controller';

describe('MetricsController', () => {
  it('delegates to MetricsService.getMetrics()', async () => {
    const getMetrics = jest.fn().mockResolvedValue('# HELP auth_http_requests_total');
    const c = new MetricsController({ getMetrics } as never);
    await expect(c.getMetrics()).resolves.toContain('auth_http_requests_total');
    expect(getMetrics).toHaveBeenCalled();
  });

  it('declares Prometheus Content-Type on the metrics handler', () => {
    const headers = Reflect.getMetadata(HEADERS_METADATA, MetricsController.prototype.getMetrics);
    expect(headers).toEqual(
      expect.arrayContaining([{ name: 'Content-Type', value: OPS_METRICS_CONTENT_TYPE }]),
    );
  });
});
