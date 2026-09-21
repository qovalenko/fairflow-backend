import { MetricsService } from './metrics.service';

describe('MetricsService', () => {
  it('records HTTP request counters and histogram observations', async () => {
    const svc = new MetricsService();
    svc.recordRequest('GET', '/healthz', 200, 12);
    svc.recordRequest('POST', '/graphql', 500, 250);

    const text = await svc.getMetrics();
    expect(text).toContain('http_requests_total');
    expect(text).toMatch(/method="GET".*route="\/healthz".*status_code="200"/);
    expect(text).toMatch(/method="POST".*route="\/graphql".*status_code="500"/);
    expect(text).toContain('http_request_duration_seconds');
  });

  it('exposes default process metrics via the registry', async () => {
    const svc = new MetricsService();
    const text = await svc.getMetrics();
    expect(text).toContain('process_cpu');
  });
});
