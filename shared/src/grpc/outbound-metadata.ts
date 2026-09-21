import { Metadata } from '@grpc/grpc-js';
import { randomUUID } from 'node:crypto';
import { GW_METADATA } from './metadata-keys';

type Headers = Record<string, string | string[] | undefined>;

function header(h: Headers, name: string): string | undefined {
  const v = h[name.toLowerCase()] ?? h[name];
  return typeof v === 'string' ? v : v?.[0];
}

export type GatewayActorType = 'user' | 'service';

export interface BuildGatewayOutboundMetadataInput {
  serviceApiKey: string;
  gatewayApiKeyId: string;
  headers: Headers;
  /** End-user id when JWT present */
  userId?: string;
  projectId?: string;
  orgId?: string;
  roles?: string;
  permissions?: string;
  sessionId?: string;
  actorType: GatewayActorType;
  enabledModules?: string[];
  modulePolicySnapshot?: string;
  /** chat (M-CHAT-10, B-3): individual-mode workspace boundary. Set by the gateway
   * from the resolved session/headers — the domain reads it from metadata, never
   * the body. DM/group conversations of users without a corporate org isolate by
   * `(workspace)`. (contracts/chat.md §1/§2.2). */
  workspaceId?: string;
  /** chat (B-3): corporate organization boundary for DM/group isolation. */
  organizationId?: string;
  /** Serialized record-visibility scope (see serializeVisibilityScope) — phase 4d. */
  visibilityScope?: string;
  /**
   * Compiled ABAC predicate resolved on the gateway (base64 JSON `CompiledPredicate`,
   * see serializeCompiledPredicate) — carried in `x-access-predicate`, AND-ed by CRM
   * domains into their read filter (RFC-5 §1.4, RFC-ABAC §7). Set ONLY when the
   * gateway resolved a non-empty predicate from the project's module policies; absent
   * = no ABAC narrowing (projectId + visibility still hold — NOT fail-open). The
   * gateway NEVER sets a malformed value: an uncompilable predicate ⇒ header omitted.
   */
  accessPredicate?: string;
}

/**
 * Service-to-service outbound metadata for internal (non-gateway) callers.
 *
 * Used when a domain calls another domain's gRPC directly (not via the gateway),
 * e.g. notification/control resolving PII from auth `UserDirectoryGrpc.ResolveUsers`.
 * Carries the service-API-key envelope plus propagated request/trace context so the
 * callee's inbound key guard can authenticate and audit the call. Deliberately does
 * NOT set PROJECT_ID — s2s directory lookups are not project-scoped; add it per-call
 * where the target RPC is tenant-scoped (see product cross-domain-count for that shape).
 */
export function buildServiceOutboundMetadata(input: { serviceApiKey: string }): Metadata {
  const m = new Metadata();
  if (input.serviceApiKey) m.set(GW_METADATA.SERVICE_API_KEY, input.serviceApiKey);
  m.set(GW_METADATA.REQUEST_ID, randomUUID());
  m.set(GW_METADATA.TRACE_ID, randomUUID());
  // TODO-475: server-minted per-call id (see GW_METADATA.CALL_ID).
  m.set(GW_METADATA.CALL_ID, randomUUID());
  m.set(GW_METADATA.GATEWAY_ISSUED_AT, String(Date.now()));
  m.set(GW_METADATA.ACTOR_TYPE, 'service');
  return m;
}

/** Metadata gateway attaches to every downstream gRPC call (architecture-api-rules-v1). */
export function buildGatewayOutboundMetadata(input: BuildGatewayOutboundMetadataInput): Metadata {
  const m = new Metadata();
  m.set(GW_METADATA.SERVICE_API_KEY, input.serviceApiKey);
  m.set(GW_METADATA.GATEWAY_API_KEY_ID, input.gatewayApiKeyId || '');
  const rid = header(input.headers, 'x-request-id') ?? randomUUID();
  m.set(GW_METADATA.REQUEST_ID, rid);
  // TODO-475: identifier of THIS call, minted server-side on every build and
  // deliberately NOT derived from any client header — `x-request-id` above is
  // echoed from the caller when it sends one, so it must never be used as the
  // dedup key of an audit fact (a client could pin it and collapse 100 exports
  // into one journal entry). See GW_METADATA.CALL_ID.
  m.set(GW_METADATA.CALL_ID, randomUUID());
  const tp = header(input.headers, 'traceparent');
  if (tp) m.set(GW_METADATA.TRACEPARENT, tp);
  const tid = header(input.headers, 'x-trace-id') ?? randomUUID();
  m.set(GW_METADATA.TRACE_ID, tid);
  m.set(GW_METADATA.USER_ID, (input.userId ?? '').trim());
  m.set(GW_METADATA.PROJECT_ID, (input.projectId ?? '').trim());
  m.set(GW_METADATA.ORG_ID, (input.orgId ?? '').trim());
  m.set(GW_METADATA.ROLES, input.roles ?? '');
  m.set(GW_METADATA.PERMISSIONS, input.permissions ?? '');
  m.set(GW_METADATA.SESSION_ID, input.sessionId ?? '');
  m.set(GW_METADATA.ACTOR_TYPE, input.actorType);
  const idem = header(input.headers, 'idempotency-key');
  if (idem) m.set(GW_METADATA.IDEMPOTENCY_KEY, idem);
  m.set(GW_METADATA.GATEWAY_ISSUED_AT, String(Date.now()));
  // [review-1] Presence, not emptiness, is the signal: an EMPTY resolved set must
  // travel as '[]' so a domain can tell "no module is enabled" (fail closed) from
  // "the gateway sent nothing" (no header at all — non-project-scoped route, old
  // contract). Gating on `.length` dropped the header precisely in the degraded
  // case, and search — whose only module gate is the type∩modules intersection,
  // since /search/query carries no @RequireModule (T-018) — then silently stopped
  // filtering. Callers that legitimately have no module context still pass
  // `undefined` and still get no header.
  if (input.enabledModules) {
    m.set(GW_METADATA.ENABLED_MODULES, JSON.stringify(input.enabledModules));
  }
  if (input.modulePolicySnapshot) {
    m.set(GW_METADATA.MODULE_POLICY_SNAPSHOT, input.modulePolicySnapshot);
  }
  if (input.visibilityScope) {
    m.set(GW_METADATA.VISIBILITY_SCOPE, input.visibilityScope);
  }
  if (input.accessPredicate) {
    m.set(GW_METADATA.ACCESS_PREDICATE, input.accessPredicate);
  }
  // chat (M-CHAT-10, B-3): individual/corporate communication boundary for DM/group
  // isolation. Set only here by the gateway.
  if (input.workspaceId) {
    m.set(GW_METADATA.WORKSPACE_ID, input.workspaceId.trim());
  }
  if (input.organizationId) {
    m.set(GW_METADATA.ORGANIZATION_ID, input.organizationId.trim());
  }
  return m;
}
