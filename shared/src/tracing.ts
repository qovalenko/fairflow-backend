/**
 * Standard headers for request correlation and distributed tracing.
 * All services should propagate these when calling other services.
 */
export const TRACE_HEADERS = {
  REQUEST_ID: 'x-request-id',
  TRACE_ID: 'x-trace-id',
  TRACEPARENT: 'traceparent',
} as const;

export type TraceHeaders = {
  [TRACE_HEADERS.REQUEST_ID]?: string;
  [TRACE_HEADERS.TRACE_ID]?: string;
  [TRACE_HEADERS.TRACEPARENT]?: string;
};

/**
 * Build headers object to forward to downstream services (copy from incoming or generate).
 */
export function tracingHeaders(overrides?: Partial<TraceHeaders>): TraceHeaders {
  return {
    ...overrides,
  };
}
