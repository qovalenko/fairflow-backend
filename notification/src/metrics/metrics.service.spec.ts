import { MetricsService, NOTIFICATION_METRIC_NAMES } from './metrics.service';

describe('MetricsService (notification domain)', () => {
  it('exposes created/email/suppressed/consumer_lag series (NFR-060)', async () => {
    const svc = new MetricsService();
    svc.recordCreated('deals', 'info');
    svc.recordEmailSent('critical');
    svc.recordEmailFailed('critical');
    svc.recordSuppressed('module_disabled');
    svc.setConsumerLagMs(1500);
    svc.observeFanout(250, 2);

    const text = await svc.getMetrics();
    expect(text).toContain(NOTIFICATION_METRIC_NAMES.CREATED_TOTAL);
    expect(text).toContain(NOTIFICATION_METRIC_NAMES.EMAIL_SENT_TOTAL);
    expect(text).toContain(NOTIFICATION_METRIC_NAMES.EMAIL_FAILED_TOTAL);
    expect(text).toContain(NOTIFICATION_METRIC_NAMES.SUPPRESSED_TOTAL);
    expect(text).toContain(NOTIFICATION_METRIC_NAMES.CONSUMER_LAG_MS);
    expect(text).toContain(NOTIFICATION_METRIC_NAMES.FANOUT_CHUNKS_TOTAL);
    expect(text).toContain('ff_notification_critical_email_failed_total');
  });
});
