import { MetricsService } from './metrics.service';

describe('MetricsService', () => {
  it('records HTTP request counters and histograms', async () => {
    const svc = new MetricsService();
    svc.recordRequest('GET', '/healthz', 200, 12);
    svc.recordRequest('POST', '/metrics', 500, 40);
    const text = await svc.getMetrics();
    expect(text).toContain('http_requests_total');
    expect(text).toMatch(/method="GET".*route="\/healthz".*status_code="200"/);
    expect(text).toContain('http_request_duration_seconds');
  });
});
