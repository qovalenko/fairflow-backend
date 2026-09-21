import { OPS_METRICS_CONTENT_TYPE } from '@fairflow/shared';
import { MetricsController } from './metrics.controller';

describe('MetricsController', () => {
  it('returns prometheus text from the metrics service', async () => {
    const metrics = {
      getMetrics: jest.fn(async () => '# TYPE http_requests_total counter\n'),
    };
    const controller = new MetricsController(metrics as never);
    await expect(controller.getMetrics()).resolves.toContain('http_requests_total');
    expect(metrics.getMetrics).toHaveBeenCalled();
  });

  it('declares the shared ops metrics content type', () => {
    const headers = Reflect.getMetadata('__headers__', MetricsController.prototype.getMetrics) as
      | Array<{ name: string; value: string }>
      | undefined;
    expect(headers).toEqual(
      expect.arrayContaining([{ name: 'Content-Type', value: OPS_METRICS_CONTENT_TYPE }]),
    );
  });
});
