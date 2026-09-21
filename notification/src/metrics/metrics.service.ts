import { Injectable } from '@nestjs/common';
import { Registry, Counter, Gauge, Histogram, collectDefaultMetrics } from 'prom-client';
import {
  MODULE_METRIC_NAMES,
  MODULE_DURATION_BUCKETS_MS,
  moduleMetrics,
  type ModuleMetrics,
  type ModuleResult,
} from '@fairflow/shared';

const MODULE_NAME = 'notification';

/** Domain-specific series (NFR-060). */
export const NOTIFICATION_METRIC_NAMES = {
  CREATED_TOTAL: 'ff_notification_created_total',
  EMAIL_SENT_TOTAL: 'ff_notification_email_sent_total',
  EMAIL_FAILED_TOTAL: 'ff_notification_email_failed_total',
  SUPPRESSED_TOTAL: 'ff_notification_suppressed_total',
  CONSUMER_LAG_MS: 'ff_notification_consumer_lag_ms',
  FANOUT_RECIPIENTS: 'ff_notification_fanout_recipients',
  FANOUT_CHUNKS_TOTAL: 'ff_notification_fanout_chunks_total',
  REMINDER_DELIVERY_LAG_MS: 'ff_activity_reminder_delivery_lag_ms',
} as const;

@Injectable()
export class MetricsService {
  readonly registry: Registry;
  private readonly httpRequestsTotal: Counter;
  private readonly httpRequestDuration: Histogram;
  readonly module: ModuleMetrics;
  private readonly createdTotal: Counter;
  private readonly emailSentTotal: Counter;
  private readonly emailFailedTotal: Counter;
  private readonly suppressedTotal: Counter;
  private readonly consumerLagMs: Gauge;
  private readonly fanoutRecipients: Histogram;
  private readonly fanoutChunksTotal: Counter;
  private readonly criticalEmailFailedTotal: Counter;
  private readonly reminderDeliveryLagMs: Histogram;

  constructor() {
    this.registry = new Registry();
    collectDefaultMetrics({ register: this.registry });

    this.httpRequestsTotal = new Counter({
      name: 'http_requests_total',
      help: 'Total HTTP requests',
      labelNames: ['method', 'route', 'status_code'],
      registers: [this.registry],
    });

    this.httpRequestDuration = new Histogram({
      name: 'http_request_duration_seconds',
      help: 'HTTP request duration in seconds',
      labelNames: ['method', 'route', 'status_code'],
      registers: [this.registry],
    });

    const requestsTotal = new Counter({
      name: MODULE_METRIC_NAMES.REQUESTS_TOTAL,
      help: 'Per-module requests total',
      labelNames: ['module', 'method', 'result'],
      registers: [this.registry],
    });
    const requestDurationMs = new Histogram({
      name: MODULE_METRIC_NAMES.REQUEST_DURATION_MS,
      help: 'Per-module request duration (ms)',
      labelNames: ['module', 'method'],
      buckets: [...MODULE_DURATION_BUCKETS_MS],
      registers: [this.registry],
    });
    const eventsConsumedTotal = new Counter({
      name: MODULE_METRIC_NAMES.EVENTS_CONSUMED_TOTAL,
      help: 'Bus events consumed by notification materializer',
      labelNames: ['module', 'result'],
      registers: [this.registry],
    });
    const dlqDepth = new Gauge({
      name: MODULE_METRIC_NAMES.DLQ_DEPTH,
      help: 'Current dead-letter queue depth (alert on growth)',
      labelNames: ['module'],
      registers: [this.registry],
    });

    this.module = moduleMetrics(MODULE_NAME, {
      requestsTotal,
      requestDurationMs,
      eventsConsumedTotal,
      dlqDepth,
    });

    this.createdTotal = new Counter({
      name: NOTIFICATION_METRIC_NAMES.CREATED_TOTAL,
      help: 'Notifications materialized (new documents)',
      labelNames: ['category', 'severity'],
      registers: [this.registry],
    });
    this.emailSentTotal = new Counter({
      name: NOTIFICATION_METRIC_NAMES.EMAIL_SENT_TOTAL,
      help: 'Email channel deliveries succeeded',
      labelNames: ['severity'],
      registers: [this.registry],
    });
    this.emailFailedTotal = new Counter({
      name: NOTIFICATION_METRIC_NAMES.EMAIL_FAILED_TOTAL,
      help: 'Email channel deliveries failed — alert when severity=critical',
      labelNames: ['severity'],
      registers: [this.registry],
    });
    this.criticalEmailFailedTotal = new Counter({
      name: 'ff_notification_critical_email_failed_total',
      help: 'Critical-severity email failures (SRE alert target)',
      registers: [this.registry],
    });
    this.suppressedTotal = new Counter({
      name: NOTIFICATION_METRIC_NAMES.SUPPRESSED_TOTAL,
      help: 'Notifications suppressed (prefs / collapse / module disabled)',
      labelNames: ['reason'],
      registers: [this.registry],
    });
    this.consumerLagMs = new Gauge({
      name: NOTIFICATION_METRIC_NAMES.CONSUMER_LAG_MS,
      help: 'Approximate consumer lag (ms) from envelope occurredAt',
      registers: [this.registry],
    });
    this.fanoutRecipients = new Histogram({
      name: NOTIFICATION_METRIC_NAMES.FANOUT_RECIPIENTS,
      help: 'Recipient count per materialized event',
      buckets: [1, 5, 10, 25, 50, 100, 200, 500, 1000],
      registers: [this.registry],
    });
    this.fanoutChunksTotal = new Counter({
      name: NOTIFICATION_METRIC_NAMES.FANOUT_CHUNKS_TOTAL,
      help: 'Fan-out chunks processed (NFR-050)',
      registers: [this.registry],
    });
    this.reminderDeliveryLagMs = new Histogram({
      name: NOTIFICATION_METRIC_NAMES.REMINDER_DELIVERY_LAG_MS,
      help: 'Activity reminder delivery lag from fireAt (NFR-ACT-050)',
      buckets: [1_000, 5_000, 15_000, 30_000, 60_000, 120_000, 300_000, 600_000],
      registers: [this.registry],
    });
  }

  recordRequest(method: string, route: string, statusCode: number, durationMs: number): void {
    const status = String(statusCode);
    this.httpRequestsTotal.inc({ method, route, status_code: status });
    this.httpRequestDuration.observe({ method, route, status_code: status }, durationMs / 1000);
  }

  recordEventConsumed(result: ModuleResult): void {
    this.module.recordEventConsumed(result);
  }

  recordCreated(category: string, severity: string): void {
    this.createdTotal.inc({ category: category || 'unknown', severity: severity || 'info' });
  }

  recordEmailSent(severity: string): void {
    this.emailSentTotal.inc({ severity: severity || 'info' });
  }

  recordEmailFailed(severity: string): void {
    this.emailFailedTotal.inc({ severity: severity || 'info' });
    if (severity === 'critical') this.criticalEmailFailedTotal.inc();
  }

  recordSuppressed(reason: string): void {
    this.suppressedTotal.inc({ reason });
  }

  setConsumerLagMs(lagMs: number): void {
    this.consumerLagMs.set(Math.max(0, lagMs));
  }

  observeFanout(recipientCount: number, chunkCount: number): void {
    this.fanoutRecipients.observe(recipientCount);
    if (chunkCount > 0) this.fanoutChunksTotal.inc(chunkCount);
  }

  observeReminderDeliveryLag(lagMs: number): void {
    this.reminderDeliveryLagMs.observe(Math.max(0, lagMs));
  }

  async getMetrics(): Promise<string> {
    return this.registry.metrics();
  }
}
