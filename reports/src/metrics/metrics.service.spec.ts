import { Registry, Counter, Histogram } from 'prom-client';
import { MODULE_METRIC_NAMES, MODULE_DURATION_BUCKETS_MS } from '@fairflow/shared';
import { MetricsService } from './metrics.service';

describe('NFR-040: SLA-метрики RunReport (ff_module_request_duration_ms)', () => {
  it('регистрирует гистограмму длительности RunReport (бакеты shared, max 5s)', async () => {
    const svc = new MetricsService();
    svc.recordModuleRequest('RunReport', 'ok', 150);
    const text = await svc.registry.metrics();
    expect(text).toContain(MODULE_METRIC_NAMES.REQUEST_DURATION_MS);
    expect(text).toContain('module="reports"');
    expect(text).toContain('method="RunReport"');
    const buckets = [...MODULE_DURATION_BUCKETS_MS];
    expect(buckets).toContain(1_000);
    expect(buckets).toContain(2_500);
    expect(buckets[buckets.length - 1]).toBeGreaterThanOrEqual(2_000);
    // Shared buckets max at 5s; p99≤10s needs MODULE_DURATION_BUCKETS_MS ≥10000 (OQ-REPORTS-090).
    expect(buckets[buckets.length - 1]).toBe(5_000);
  });

  it('инкрементирует счётчик запросов с result=ok|error', async () => {
    const svc = new MetricsService();
    svc.recordModuleRequest('RunReport', 'error', 50);
    const text = await svc.registry.metrics();
    expect(text).toContain(MODULE_METRIC_NAMES.REQUESTS_TOTAL);
    expect(text).toContain('result="error"');
  });

  it('getMetrics возвращает prometheus text, recordRequest пишет http_* метрики', async () => {
    const svc = new MetricsService();
    svc.recordRequest('GET', '/metrics', 200, 25);
    const text = await svc.getMetrics();
    expect(text).toContain('http_requests_total');
    expect(text).toContain('route="/metrics"');
  });
});
