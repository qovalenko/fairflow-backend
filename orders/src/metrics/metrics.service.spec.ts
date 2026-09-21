import { MetricsService } from './metrics.service';

describe('MetricsService', () => {
  it('records HTTP request counters and histograms', async () => {
    const svc = new MetricsService();
    svc.recordRequest('GET', '/readyz', 200, 12);
    svc.recordRequest('GET', '/readyz', 503, 3);

    const text = await svc.getMetrics();
    expect(text).toContain('http_requests_total');
    expect(text).toContain('http_request_duration_seconds');
    expect(text).toMatch(/method="GET"/);
    expect(text).toMatch(/route="\/readyz"/);
  });

  it('exposes default process metrics via the registry', async () => {
    const svc = new MetricsService();
    const text = await svc.getMetrics();
    expect(text).toContain('process_cpu');
  });
});
