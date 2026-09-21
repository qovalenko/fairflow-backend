import { Metadata } from '@grpc/grpc-js';
import {
  GW_METADATA,
  buildGatewayOutboundMetadata,
  type BuildGatewayOutboundMetadataInput,
} from '@fairflow/shared';

/**
 * Ergonomic gRPC-metadata factory for domain tests (QA-CI T-026).
 *
 * A domain handler NEVER parses a JWT — it trusts the `x-*` metadata the gateway
 * attaches after RBAC/ABAC/visibility resolution (see
 * `buildGatewayOutboundMetadata`, the production builder we delegate to). Tests
 * must exercise handlers with metadata shaped EXACTLY as the gateway emits it,
 * otherwise a component test can pass while the real isolation/permission path
 * is broken. This factory is the single place that mirrors that shape for tests.
 *
 * Defaults produce a valid authenticated *user* context (request-id, trace-id,
 * gateway-issued-at, actor-type=user + user-id) so `validatePropagatedGatewayMetadata`
 * passes out of the box. Override only what the test cares about.
 */
export interface GatewayMetadataContext {
  userId?: string;
  projectId?: string;
  orgId?: string;
  organizationId?: string;
  workspaceId?: string;
  /** Coarse project roles (x-roles). Array is comma-joined as the gateway does. */
  roles?: string[] | string;
  /** Effective permission keys (x-permissions). */
  permissions?: string[] | string;
  sessionId?: string;
  actorType?: 'user' | 'service';
  enabledModules?: string[];
  /** Already-serialized visibility scope (see serializeVisibilityScope). */
  visibilityScope?: string;
  /**
   * ABAC predicate. Pass the structured `{ mongo, ir }` and it is base64(JSON)
   * encoded to match `readAccessPredicate`; pass a string to inject a raw
   * (possibly malformed) header for fail-closed tests.
   */
  accessPredicate?: string | { mongo?: Record<string, unknown> | null; ir?: unknown };
  /** Client idempotency key (idempotency-key). */
  idempotencyKey?: string;
  /** Extra raw headers merged into the source header bag (e.g. traceparent). */
  headers?: Record<string, string>;
  serviceApiKey?: string;
  gatewayApiKeyId?: string;
}

function csv(v: string[] | string | undefined): string | undefined {
  if (v == null) return undefined;
  return Array.isArray(v) ? v.join(',') : v;
}

function encodeAccessPredicate(
  p: GatewayMetadataContext['accessPredicate'],
): string | undefined {
  if (p == null) return undefined;
  if (typeof p === 'string') return p;
  return Buffer.from(JSON.stringify({ mongo: p.mongo ?? null, ir: p.ir ?? null })).toString(
    'base64',
  );
}

/**
 * Build a gateway→domain `Metadata` object for tests. Delegates to the production
 * `buildGatewayOutboundMetadata` so the wire shape can never drift from real code.
 */
export function buildGatewayMetadata(ctx: GatewayMetadataContext = {}): Metadata {
  const headers: Record<string, string> = {
    'x-request-id': 'test-req-' + Math.random().toString(36).slice(2, 10),
    'x-trace-id': 'test-trace-' + Math.random().toString(36).slice(2, 10),
    ...(ctx.idempotencyKey ? { 'idempotency-key': ctx.idempotencyKey } : {}),
    ...(ctx.headers ?? {}),
  };
  const actorType = ctx.actorType ?? 'user';
  return buildGatewayOutboundMetadata({
    serviceApiKey: ctx.serviceApiKey ?? 'test-service-key',
    gatewayApiKeyId: ctx.gatewayApiKeyId ?? 'test-gw-key',
    headers,
    userId: actorType === 'user' ? (ctx.userId ?? 'user-test') : (ctx.userId ?? ''),
    projectId: ctx.projectId,
    orgId: ctx.orgId,
    roles: csv(ctx.roles),
    permissions: csv(ctx.permissions),
    sessionId: ctx.sessionId,
    actorType,
    enabledModules: ctx.enabledModules,
    workspaceId: ctx.workspaceId,
    organizationId: ctx.organizationId,
    visibilityScope: ctx.visibilityScope,
    accessPredicate: encodeAccessPredicate(ctx.accessPredicate),
  });
}

/** Metadata for an internal service-to-service caller (no user, no project). */
export function buildServiceMetadata(serviceApiKey = 'test-service-key'): Metadata {
  const m = new Metadata();
  m.set(GW_METADATA.SERVICE_API_KEY, serviceApiKey);
  m.set(GW_METADATA.REQUEST_ID, 'test-req-' + Math.random().toString(36).slice(2, 10));
  m.set(GW_METADATA.TRACE_ID, 'test-trace-' + Math.random().toString(36).slice(2, 10));
  m.set(GW_METADATA.GATEWAY_ISSUED_AT, String(Date.now()));
  m.set(GW_METADATA.ACTOR_TYPE, 'service');
  return m;
}
