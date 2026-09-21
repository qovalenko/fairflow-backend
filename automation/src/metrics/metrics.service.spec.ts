import { MetricsService } from './metrics.service';

describe('MetricsService', () => {
  it('records HTTP request counters and histograms', async () => {
    const svc = new MetricsService();
    svc.recordRequest('GET', '/metrics', 200, 25);
    svc.recordRequest('POST', '/api/x', 500, 120);
    const text = await svc.getMetrics();
    expect(text).toContain('http_requests_total');
    expect(text).toContain('method="GET"');
    expect(text).toContain('route="/metrics"');
    expect(text).toContain('status_code="500"');
    expect(text).toContain('http_request_duration_seconds');
  });
});
