import { MetricsService } from './metrics.service';

describe('MetricsService (platform domain)', () => {
  it('records HTTP request counters and histograms', async () => {
    const svc = new MetricsService();

    svc.recordRequest('GET', '/metrics', 200, 25);
    svc.recordRequest('POST', '/readyz', 503, 10);

    const text = await svc.getMetrics();
    expect(text).toContain('http_requests_total');
    expect(text).toContain('http_request_duration_seconds');
    expect(text).toContain('method="GET"');
    expect(text).toContain('status_code="503"');
  });
});
