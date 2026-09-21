import { MetricsService } from './metrics.service';

describe('MetricsService (NFR-DOCS-080)', () => {
  it('records documents business counters', async () => {
    const svc = new MetricsService();
    svc.recordDocumentsOperation('generate');
    svc.recordDocumentsOperation('download');
    svc.recordDocumentsError('TEMPLATE_INVALID');
    const text = await svc.getMetrics();
    expect(text).toContain('documents_operations_total');
    expect(text).toContain('documents_errors_total');
    expect(text).toMatch(/operation="generate"/);
    expect(text).toMatch(/operation="download"/);
    expect(text).toMatch(/code="TEMPLATE_INVALID"/);
  });
});
