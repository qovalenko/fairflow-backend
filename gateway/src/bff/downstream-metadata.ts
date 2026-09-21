import { Metadata } from '@grpc/grpc-js';

/** Mirrors docs/architecture/gateway-services-grpc-spec — propagate gateway context to downstream gRPC. */
export const GW_META = {
  REQUEST_ID: 'x-request-id',
  USER_ID: 'x-user-id',
  PROJECT_ID: 'x-project-id',
  ENABLED_MODULES: 'x-enabled-modules',
  IDEMPOTENCY_KEY: 'idempotency-key',
  TRACEPARENT: 'traceparent',
  GATEWAY_ISSUED_AT: 'x-gateway-issued-at',
} as const;

type Headers = Record<string, string | string[] | undefined>;

function header(h: Headers, name: string): string | undefined {
  const v = h[name];
  return typeof v === 'string' ? v : v?.[0];
}

/** Build metadata for outbound gRPC (services may enforce x-user-id from gateway). */
export function buildDownstreamMetadata(
  req: { headers: Headers; user?: { userId?: string } },
  opts?: { projectId?: string },
): Metadata {
  const m = new Metadata();
  const rid = header(req.headers, 'x-request-id');
  if (rid) m.set(GW_META.REQUEST_ID, rid);
  if (req.user?.userId) m.set(GW_META.USER_ID, req.user.userId);
  if (opts?.projectId) m.set(GW_META.PROJECT_ID, opts.projectId);
  const idem = header(req.headers, 'idempotency-key');
  if (idem) m.set(GW_META.IDEMPOTENCY_KEY, idem);
  const tp = header(req.headers, 'traceparent');
  if (tp) m.set(GW_META.TRACEPARENT, tp);
  m.set(GW_META.GATEWAY_ISSUED_AT, String(Date.now()));
  return m;
}
