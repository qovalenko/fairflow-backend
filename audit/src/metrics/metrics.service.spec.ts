import { MODULE_METRIC_NAMES } from '@fairflow/shared';
import { MetricsService } from './metrics.service';

describe('MetricsService (audit domain)', () => {
  it('records HTTP, module, ingest-rejection and DLQ observability series', async () => {
    const svc = new MetricsService();

    svc.recordRequest('GET', '/metrics', 200, 12);
    svc.recordEventConsumed('ok');
    svc.recordEventConsumed('error');
    svc.recordIngestRejected('missing_project_id');
    svc.setDlqDepth(4);

    const text = await svc.getMetrics();
    expect(text).toContain('http_requests_total');
    expect(text).toContain(MODULE_METRIC_NAMES.REQUESTS_TOTAL);
    expect(text).toContain(MODULE_METRIC_NAMES.EVENTS_CONSUMED_TOTAL);
    expect(text).toContain(MODULE_METRIC_NAMES.DLQ_DEPTH);
    expect(text).toContain('ff_audit_events_rejected_total');
    expect(text).toContain('missing_project_id');
  });
});
