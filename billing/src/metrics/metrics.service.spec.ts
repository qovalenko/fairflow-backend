import { MetricsService } from './metrics.service';
import { MetricsController } from './metrics.controller';

describe('MetricsService', () => {
  it('records HTTP request counters and histograms', async () => {
    const svc = new MetricsService();
    const before = await svc.getMetrics();
    svc.recordRequest('GET', '/metrics', 200, 12);
    const text = await svc.getMetrics();
    expect(before).not.toMatch(/route="\/metrics"/);
    expect(text).toMatch(
      /http_requests_total\{method="GET",route="\/metrics",status_code="200"\} 1/,
    );
    expect(text).toMatch(
      /http_request_duration_seconds_count\{method="GET",route="\/metrics",status_code="200"\} 1/,
    );
  });
});

describe('MetricsController', () => {
  it('delegates /metrics to MetricsService', async () => {
    const metrics = { getMetrics: jest.fn().mockResolvedValue('metric_body') };
    const ctl = new MetricsController(metrics as unknown as MetricsService);
    await expect(ctl.getMetrics()).resolves.toBe('metric_body');
  });
});
