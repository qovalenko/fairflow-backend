import { MetricsController } from './metrics.controller';
import { MetricsService } from './metrics.service';

describe('MetricsService', () => {
  it('records HTTP request counters and histograms', async () => {
    const svc = new MetricsService();
    svc.recordRequest('GET', '/healthz', 200, 12);
    svc.recordRequest('POST', '/graphql', 500, 250);

    const text = await svc.getMetrics();
    expect(text).toContain('http_requests_total');
    expect(text).toContain('http_request_duration_seconds');
    expect(text).toMatch(/method="GET".*route="\/healthz".*status_code="200"/);
    expect(text).toMatch(/method="POST".*status_code="500"/);
  });
});

describe('MetricsController', () => {
  it('delegates /metrics to the registry', async () => {
    const metrics = { getMetrics: jest.fn().mockResolvedValue('# HELP ok') };
    const controller = new MetricsController(metrics as never);
    await expect(controller.getMetrics()).resolves.toBe('# HELP ok');
    expect(metrics.getMetrics).toHaveBeenCalled();
  });
});
