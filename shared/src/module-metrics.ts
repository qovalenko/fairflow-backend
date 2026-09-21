/**
 * Per-module observability contract — FR-NFR-14 (cross-cutting-nfr §4.4),
 * exposed by every domain on `/metrics` (ops-http-contract).
 *
 * The mandatory minimum, every series carrying a `module` label:
 *  - `ff_module_requests_total{module,method,result}`            (counter)
 *  - `ff_module_request_duration_ms{module,method}`             (histogram, p50/p95/p99)
 *
 * Event/audit consumers additionally expose (FR-NFR-32, FR-EVT integrity):
 *  - `ff_module_events_consumed_total{module,result}`           (counter)
 *  - `ff_module_dlq_depth{module}`                              (gauge)
 *
 * `shared` stays free of a prom-client dependency (storage/transport-agnostic,
 * like the outbox contracts). A domain passes thin adapters over its existing
 * prom-client `Registry`; {@link moduleMetrics} wires the canonical names/labels
 * so two domains can't drift on metric naming.
 */

/** Canonical metric names (single source of truth — FR-NFR-14). */
export const MODULE_METRIC_NAMES = {
  REQUESTS_TOTAL: 'ff_module_requests_total',
  REQUEST_DURATION_MS: 'ff_module_request_duration_ms',
  EVENTS_CONSUMED_TOTAL: 'ff_module_events_consumed_total',
  DLQ_DEPTH: 'ff_module_dlq_depth',
} as const;

/** Histogram buckets (ms) tuned for gRPC/consumer latencies (p50..p99). */
export const MODULE_DURATION_BUCKETS_MS: readonly number[] = [
  5, 10, 25, 50, 100, 250, 500, 1_000, 2_500, 5_000,
];

/** Result label values for request/consume outcomes. */
export type ModuleResult = 'ok' | 'error' | 'denied';

/** Minimal counter sink (prom-client `Counter` satisfies this). */
export interface CounterSink {
  inc(labels: Record<string, string>, value?: number): void;
}

/** Minimal histogram sink (prom-client `Histogram` satisfies this). */
export interface HistogramSink {
  observe(labels: Record<string, string>, value: number): void;
}

/** Minimal gauge sink (prom-client `Gauge` satisfies this). */
export interface GaugeSink {
  set(labels: Record<string, string>, value: number): void;
}

/**
 * Factory a domain creates once per metric family, providing pre-named sinks
 * from its own registry. Keeps the canonical names/labels in one place.
 */
export interface ModuleMetricSinks {
  requestsTotal: CounterSink;
  requestDurationMs: HistogramSink;
  eventsConsumedTotal?: CounterSink;
  dlqDepth?: GaugeSink;
}

/** Bound per-module metric recorder. */
export interface ModuleMetrics {
  readonly module: string;
  /** Record a gRPC/HTTP request outcome + latency. */
  recordRequest(method: string, result: ModuleResult, durationMs: number): void;
  /** Record a consumed bus event outcome (ok/error → DLQ ladder). */
  recordEventConsumed(result: ModuleResult): void;
  /** Publish the current dead-letter queue depth (alert on growth). */
  setDlqDepth(depth: number): void;
}

/**
 * Bind the canonical per-module metrics to a domain's sinks. The `module` label
 * is fixed for all series so SRE can slice every domain uniformly (FR-NFR-14).
 */
export function moduleMetrics(module: string, sinks: ModuleMetricSinks): ModuleMetrics {
  return {
    module,
    recordRequest(method, result, durationMs) {
      sinks.requestsTotal.inc({ module, method, result });
      sinks.requestDurationMs.observe({ module, method }, durationMs);
    },
    recordEventConsumed(result) {
      sinks.eventsConsumedTotal?.inc({ module, result });
    },
    setDlqDepth(depth) {
      sinks.dlqDepth?.set({ module }, depth);
    },
  };
}
