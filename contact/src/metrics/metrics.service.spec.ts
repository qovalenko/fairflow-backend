import { MetricsService } from './metrics.service';

describe('MetricsService', () => {
  it('records HTTP request counters and histograms', async () => {
    const svc = new MetricsService();
    svc.recordRequest('GET', '/healthz', 200, 12);
    const text = await svc.getMetrics();
    expect(text).toContain('http_requests_total');
    expect(text).toContain('method="GET"');
    expect(text).toContain('route="/healthz"');
    expect(text).toContain('status_code="200"');
    expect(text).toContain('http_request_duration_seconds');
  });

  it('exports default process metrics via the registry', async () => {
    const svc = new MetricsService();
    const text = await svc.getMetrics();
    expect(text).toContain('process_cpu');
  });
});
