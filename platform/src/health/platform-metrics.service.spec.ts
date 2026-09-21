import { PlatformMetricsService } from './platform-metrics.service';

describe('PlatformMetricsService', () => {
  it('exposes default prometheus metrics from its registry', async () => {
    const svc = new PlatformMetricsService();
    const text = await svc.getMetrics();
    expect(text).toContain('process_cpu_user_seconds_total');
  });
});
