import { Injectable } from '@nestjs/common';
import { Registry, Counter, Histogram, collectDefaultMetrics } from 'prom-client';
import {
  MODULE_METRIC_NAMES,
  MODULE_DURATION_BUCKETS_MS,
  moduleMetrics,
  type ModuleMetrics,
  type ModuleResult,
} from '@fairflow/shared';

const MODULE_NAME = 'reports';

@Injectable()
export class MetricsService {
  readonly registry: Registry;
  private readonly httpRequestsTotal: Counter;
  private readonly httpRequestDuration: Histogram;
  /** Canonical per-module metrics (FR-NFR-14 / NFR-040 SLA p95/p99). */
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

    this.module = moduleMetrics(MODULE_NAME, {
      requestsTotal,
      requestDurationMs,
    });
  }

  recordModuleRequest(method: string, result: ModuleResult, durationMs: number): void {
    this.module.recordRequest(method, result, durationMs);
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
