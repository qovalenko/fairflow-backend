import { Injectable } from '@nestjs/common';
import { Registry, Counter, Gauge, Histogram, collectDefaultMetrics } from 'prom-client';
import {
  MODULE_METRIC_NAMES,
  MODULE_DURATION_BUCKETS_MS,
  moduleMetrics,
  type ModuleMetrics,
  type ModuleResult,
} from '@fairflow/shared';

const MODULE_NAME = 'audit';

@Injectable()
export class MetricsService {
  readonly registry: Registry;
  private readonly httpRequestsTotal: Counter;
  private readonly httpRequestDuration: Histogram;
  /** Canonical per-module metrics (FR-NFR-14) incl. event-consumer observability. */
  readonly module: ModuleMetrics;

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

    // --- Per-module metrics + event/audit observability (FR-NFR-14/32) ---
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
      help: 'Bus events consumed by the audit projector',
      labelNames: ['module', 'result'],
      registers: [this.registry],
    });
    const dlqDepth = new Gauge({
      name: MODULE_METRIC_NAMES.DLQ_DEPTH,
      help: 'Current dead-letter queue depth (alert on growth)',
      labelNames: ['module'],
      registers: [this.registry],
    });
    const eventsRejectedTotal = new Counter({
      name: 'ff_audit_events_rejected_total',
      help: 'Bus events rejected by the audit projector (missing scope/type)',
      labelNames: ['reason'],
      registers: [this.registry],
    });
    this.eventsRejectedTotal = eventsRejectedTotal;

    this.module = moduleMetrics(MODULE_NAME, {
      requestsTotal,
      requestDurationMs,
      eventsConsumedTotal,
      dlqDepth,
    });
  }

  private readonly eventsRejectedTotal: Counter;

  /** Count an ingest rejection (missing type/project) — observable, acked. */
  recordIngestRejected(reason: string): void {
    this.eventsRejectedTotal.inc({ reason });
  }

  /** Record a consumed bus event outcome (ok/error) — FR-NFR-32. */
  recordEventConsumed(result: ModuleResult): void {
    this.module.recordEventConsumed(result);
  }

  /** Publish the current DLQ depth (alerted by SRE on growth) — FR-NFR-32. */
  setDlqDepth(depth: number): void {
    this.module.setDlqDepth(depth);
  }

  recordRequest(method: string, route: string, statusCode: number, durationMs: number): void {
    const status = String(statusCode);
    this.httpRequestsTotal.inc({ method, route, status_code: status });
    this.httpRequestDuration.observe({ method, route, status_code: status }, durationMs / 1000);
  }

  async getMetrics(): Promise<string> {
    return this.registry.metrics();
  }
}
