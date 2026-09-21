import { Injectable } from '@nestjs/common';
import { Registry, Counter, Histogram, collectDefaultMetrics } from 'prom-client';

@Injectable()
export class MetricsService {
  readonly registry: Registry;
  private readonly httpRequestsTotal: Counter;
  private readonly httpRequestDuration: Histogram;
  // [#19] Deferred-scope hydration outcomes (plan P19 §4). Bound to the shared
  // DeferredScopeHydrator via VISIBILITY_HYDRATE_METRICS in AuthValidationModule.
  private readonly visibilityHydrateTotal: Counter;
  /** NFR-DEALS-100 — outbox relay outcomes for pipe domain ops. */
  private readonly outboxRelayTotal: Counter;

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

    this.visibilityHydrateTotal = new Counter({
      name: 'visibility_hydrate_total',
      help: 'Domain-side deferred-scope hydration outcomes (#19)',
      labelNames: ['result'],
      registers: [this.registry],
    });

    this.outboxRelayTotal = new Counter({
      name: 'pipe_outbox_relay_total',
      help: 'Transactional outbox relay tick outcomes (NFR-DEALS-100)',
      labelNames: ['result'],
      registers: [this.registry],
    });
  }

  recordRequest(method: string, route: string, statusCode: number, durationMs: number): void {
    const status = String(statusCode);
    this.httpRequestsTotal.inc({ method, route, status_code: status });
    this.httpRequestDuration.observe({ method, route, status_code: status }, durationMs / 1000);
  }

  /** [#19] result ∈ hit|miss|stale|deny|inline_skip. */
  recordVisibilityHydrate(result: string): void {
    this.visibilityHydrateTotal.inc({ result });
  }

  /** NFR-DEALS-100: result ∈ published|failed|fetched. */
  recordOutboxRelay(result: string, count = 1): void {
    if (count <= 0) return;
    this.outboxRelayTotal.inc({ result }, count);
  }

  async getMetrics(): Promise<string> {
    return this.registry.metrics();
  }
}
