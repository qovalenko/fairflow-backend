import { Injectable } from '@nestjs/common';
import { Registry, collectDefaultMetrics, Counter, Histogram } from 'prom-client';

@Injectable()
export class MetricsService {
  readonly registry: Registry;
  private readonly httpRequests: Counter<string>;
  private readonly httpDuration: Histogram<string>;

  constructor() {
    this.registry = new Registry();
    collectDefaultMetrics({ register: this.registry });
    this.httpRequests = new Counter({
      name: 'auth_http_requests_total',
      help: 'HTTP requests (health/metrics only)',
      labelNames: ['method', 'route', 'status'],
      registers: [this.registry],
    });
    this.httpDuration = new Histogram({
      name: 'auth_http_request_duration_seconds',
      help: 'HTTP request duration',
      labelNames: ['method', 'route'],
      buckets: [0.005, 0.05, 0.2, 1, 5],
      registers: [this.registry],
    });
  }

  recordRequest(method: string, route: string, statusCode: number, durationMs: number): void {
    const r = String(route).slice(0, 200) || 'unknown';
    this.httpRequests.inc({ method, route: r, status: String(statusCode) });
    this.httpDuration.observe({ method, route: r }, durationMs / 1000);
  }

  async getMetrics(): Promise<string> {
    return this.registry.metrics();
  }
}
