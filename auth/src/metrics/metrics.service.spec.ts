import { MetricsService } from './metrics.service';

describe('MetricsService HTTP instrumentation', () => {
  it('registers auth_http_requests_total and duration histogram', async () => {
    const svc = new MetricsService();
    svc.recordRequest('GET', '/healthz', 200, 12);
    const text = await svc.getMetrics();
    expect(text).toContain('auth_http_requests_total');
    expect(text).toContain('auth_http_request_duration_seconds');
    expect(text).toContain('method="GET"');
    expect(text).toContain('route="/healthz"');
    expect(text).toContain('status="200"');
  });

  it('truncates overlong route labels and treats empty route as unknown', async () => {
    const svc = new MetricsService();
    const long = '/' + 'x'.repeat(250);
    svc.recordRequest('POST', long, 500, 50);
    svc.recordRequest('GET', '', 404, 1);
    const text = await svc.getMetrics();
    expect(text).toContain(`route="${long.slice(0, 200)}"`);
    expect(text).toContain('route="unknown"');
  });
});
