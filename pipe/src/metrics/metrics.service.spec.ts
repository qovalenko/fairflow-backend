import { MetricsService } from './metrics.service';

describe('MetricsService', () => {
  it('records outbox relay counters (NFR-DEALS-100)', async () => {
    const svc = new MetricsService();
    svc.recordOutboxRelay('published', 3);
    svc.recordOutboxRelay('failed', 1);
    const text = await svc.getMetrics();
    expect(text).toContain('pipe_outbox_relay_total');
    expect(text).toMatch(/result="published".*3/);
    expect(text).toMatch(/result="failed".*1/);
  });

  it('ignores non-positive outbox relay counts', async () => {
    const svc = new MetricsService();
    svc.recordOutboxRelay('published', 0);
    svc.recordOutboxRelay('published', -1);
    const text = await svc.getMetrics();
    expect(text).not.toMatch(/result="published".*[1-9]/);
  });

  it('records HTTP request and visibility hydration counters', async () => {
    const svc = new MetricsService();
    svc.recordRequest('GET', '/healthz', 200, 12);
    svc.recordVisibilityHydrate('hit');
    svc.recordVisibilityHydrate('deny');
    const text = await svc.getMetrics();
    expect(text).toContain('http_requests_total');
    expect(text).toMatch(/method="GET".*route="\/healthz".*status_code="200"/);
    expect(text).toContain('visibility_hydrate_total');
    expect(text).toMatch(/result="hit"/);
    expect(text).toMatch(/result="deny"/);
  });
});
