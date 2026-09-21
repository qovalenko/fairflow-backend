import { MetricsController } from './metrics.controller';
import { MetricsService } from './metrics.service';

describe('MetricsController', () => {
  it('returns the registry exposition from MetricsService', async () => {
    const metrics = {
      getMetrics: jest.fn().mockResolvedValue(
        'http_requests_total{method="GET",route="/metrics",status_code="200"} 1',
      ),
    };
    const ctrl = new MetricsController(metrics as unknown as MetricsService);

    await expect(ctrl.getMetrics()).resolves.toContain(
      'http_requests_total{method="GET",route="/metrics",status_code="200"} 1',
    );
    expect(metrics.getMetrics).toHaveBeenCalledTimes(1);
  });
});
