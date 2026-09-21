import { Metadata, status } from '@grpc/grpc-js';
import { RpcException } from '@nestjs/microservices';
import { GW_METADATA } from './metadata-keys';
import { parseVisibilityScope, type VisibilityScope } from '../rbac';
import { parseEnabledModulesHeader } from '../module-gating';
import type { AbacNode } from '../abac/ir';

function firstString(m: Metadata, key: string): string {
  const v = m.get(key)?.[0];
  if (v == null) return '';
  return typeof v === 'string' ? v : v.toString();
}

/** Read a single propagated metadata value (empty string when absent). */
export function readGatewayMetadata(metadata: Metadata | undefined, key: string): string {
  return metadata ? firstString(metadata, key) : '';
}

/** End-user id propagated by the gateway (x-user-id), or '' for service actors. */
export function readUserId(metadata: Metadata | undefined): string {
  return readGatewayMetadata(metadata, GW_METADATA.USER_ID).trim();
}

/**
 * Client-supplied idempotency key propagated by the gateway (`idempotency-key`),
 * or '' when absent. Domains scope it per-operation and pass it to
 * `withIdempotency` to dedup create/merge/import mutations (P2.d). The
 * transport-level outbox dedup (RFC-4 §Р-4) only deduplicates *events*; this is
 * the dedup of the *mutation itself*.
 */
export function readIdempotencyKey(metadata: Metadata | undefined): string {
  return readGatewayMetadata(metadata, GW_METADATA.IDEMPOTENCY_KEY).trim();
}

/**
 * Server-minted identifier of THIS gRPC call (`x-gw-call-id`), or '' when absent
 * (s2s caller that did not build metadata through the shared helpers).
 *
 * TODO-475: this is the ONLY call-scoped value a domain may use as the dedup key
 * of an audit/outbox fact. `x-request-id` is echoed from the client header and
 * `idempotency-key` is client-supplied, so both can be pinned by the caller to
 * suppress facts (100 exports → 1 journal entry, FR-MSTAT-23). Empty result must
 * degrade to "no dedup key" (a duplicate fact is safe; a missing one is not).
 */
export function readCallId(metadata: Metadata | undefined): string {
  return readGatewayMetadata(metadata, GW_METADATA.CALL_ID).trim();
}

/**
 * Trusted project id propagated by the gateway (x-project-id), or '' when absent.
 * The gateway only sets this AFTER ProjectAccessGuard has verified the actor is a
 * member of that project — so domains must treat it as the source of truth for
 * project isolation, never the request body (IMPLEMENTATION-DEBT Д-2/Д-5).
 */
export function readProjectId(metadata: Metadata | undefined): string {
  return readGatewayMetadata(metadata, GW_METADATA.PROJECT_ID).trim();
}

/**
 * Resolve the effective project id for a domain handler (defense-in-depth, Д-5).
 *
 * Rule: trusted `x-project-id` metadata wins over anything in the request body.
 * - metadata present → use it; if a non-empty body projectId disagrees, reject
 *   (cross-project attempt — never silently honor the body).
 * - metadata absent → fall back to a non-empty body value (s2s/internal callers
 *   that don't go through the gateway membership check). User-facing callers must
 *   propagate x-project-id from the gateway (defense-in-depth, FR-ACCESS-030).
 * - both absent/empty → INVALID_ARGUMENT (fail-closed, FR-PROJ-030).
 *
 * Throws an RpcException-mappable error ({ code, message }) on conflict or absence.
 */
export function resolveProjectId(
  metadata: Metadata | undefined,
  bodyProjectId?: string,
): string {
  const fromMeta = readProjectId(metadata);
  const fromBody = (bodyProjectId ?? '').trim();
  if (fromMeta) {
    if (fromBody && fromBody !== fromMeta) {
      throw new RpcException({
        code: status.PERMISSION_DENIED,
        message: 'projectId in request body does not match trusted x-project-id metadata',
      });
    }
    return fromMeta;
  }
  if (!fromBody) {
    throw new RpcException({
      code: status.INVALID_ARGUMENT,
      message: 'projectId is required (x-project-id metadata or request body)',
    });
  }
  return fromBody;
}

/**
 * Project roles propagated by the gateway (x-roles), as a comma/space-separated
 * list. Empty array for service actors. Used by domain PEPs that must enforce
 * "Manager+" gates (e.g. orders retry/reassign/accept-drift). NOTE: phase-2
 * ABAC/visibility is still resolved upstream; this is only the coarse role list.
 */
export function readRoles(metadata: Metadata | undefined): string[] {
  const raw = readGatewayMetadata(metadata, GW_METADATA.ROLES).trim();
  if (!raw) return [];
  return raw
    .split(/[,\s]+/)
    .map((r) => r.trim())
    .filter(Boolean);
}

/** Parsed record-visibility scope (x-visibility-scope), or undefined — phase 4d. */
export function readVisibilityScope(metadata: Metadata | undefined): VisibilityScope | undefined {
  return parseVisibilityScope(readGatewayMetadata(metadata, GW_METADATA.VISIBILITY_SCOPE));
}

/**
 * Trusted ABAC predicate (`x-access-predicate`) resolved on the gateway, read as a
 * three-state result so a domain PEP can apply the correct semantics (RFC-5 §1.4/§7,
 * RFC-ABAC §4 fail-closed):
 *
 *  - `{ present: false }`            — header ABSENT/empty. No ABAC rules apply to
 *    this actor: the domain adds NO extra narrowing (projectId + visibility still
 *    hold). This is STANDARD, not fail-open — matches the search reference and
 *    `NO_ABAC_PREDICATE`.
 *  - `{ present: true, malformed: true }` — header present but base64/JSON is
 *    unparseable, or neither `.mongo` nor `.ir` is a usable shape. Fail-closed:
 *    the domain MUST deny (a broken deny-rule must never widen access).
 *  - `{ present: true, mongo, ir }`  — usable predicate. `mongo` (list filter) and
 *    `ir` (single-record gate via `evalGate`) are the two contract-equivalent
 *    interpretations of the same compiled predicate.
 *
 * Unlike {@link parseVisibilityScope}, a `null`/`null` compiled predicate that WAS
 * transmitted (gateway resolved "no ABAC rules") is reported as `present:false`
 * so it is treated identically to an absent header — no narrowing, no deny.
 */
export type AccessPredicate =
  | { present: false }
  | { present: true; malformed: true }
  | { present: true; malformed?: false; mongo: Record<string, unknown> | null; ir: AbacNode | null };

export function readAccessPredicate(metadata: Metadata | undefined): AccessPredicate {
  const raw = readGatewayMetadata(metadata, GW_METADATA.ACCESS_PREDICATE).trim();
  if (!raw) return { present: false };
  let obj: { mongo?: unknown; ir?: unknown };
  try {
    obj = JSON.parse(Buffer.from(raw, 'base64').toString('utf8')) as { mongo?: unknown; ir?: unknown };
  } catch {
    // Header transmitted but undecodable → treat as a broken deny-rule (fail-closed).
    return { present: true, malformed: true };
  }
  if (obj == null || typeof obj !== 'object') return { present: true, malformed: true };
  const mongoOk = obj.mongo && typeof obj.mongo === 'object' && !Array.isArray(obj.mongo);
  const irOk = obj.ir && typeof obj.ir === 'object';
  // Both null = gateway resolved "no ABAC rules" → identical to absent (no narrowing).
  if (obj.mongo == null && obj.ir == null) return { present: false };
  // A non-null value that is not a usable shape (e.g. mongo is a string/array) is a
  // corrupted predicate → deny rather than silently drop the narrowing.
  if ((obj.mongo != null && !mongoOk) || (obj.ir != null && !irOk)) {
    return { present: true, malformed: true };
  }
  return {
    present: true,
    mongo: mongoOk ? (obj.mongo as Record<string, unknown>) : null,
    ir: irOk ? (obj.ir as AbacNode) : null,
  };
}

/**
 * Effective-enabled module ids propagated by the gateway (x-enabled-modules), or
 * undefined when absent/malformed. Domains that gate per-module behaviour (e.g.
 * statistics slices over disabled source modules) read it here; absent = unknown
 * = do not gate (fail-open-on-absent, matching ModuleGuard).
 */
export function readEnabledModules(metadata: Metadata | undefined): string[] | undefined {
  return parseEnabledModulesHeader(readGatewayMetadata(metadata, GW_METADATA.ENABLED_MODULES));
}

/**
 * After API-key validation: enforce propagated gateway context (architecture-api-rules-v1).
 * Throws { code: grpc status, message } for RpcException mapping.
 */
export function validatePropagatedGatewayMetadata(metadata: Metadata | undefined): void {
  if (!metadata) {
    const e = new Error('Missing gRPC metadata') as Error & { code: number };
    e.code = status.UNAUTHENTICATED;
    throw e;
  }
  const m = metadata;
  if (!firstString(m, GW_METADATA.REQUEST_ID).trim()) {
    const e = new Error('Missing x-request-id') as Error & { code: number };
    e.code = status.UNAUTHENTICATED;
    throw e;
  }
  const trace =
    firstString(m, GW_METADATA.TRACEPARENT).trim() || firstString(m, GW_METADATA.TRACE_ID).trim();
  if (!trace) {
    const e = new Error('Missing trace context (traceparent or x-trace-id)') as Error & { code: number };
    e.code = status.UNAUTHENTICATED;
    throw e;
  }
  if (!firstString(m, GW_METADATA.GATEWAY_ISSUED_AT).trim()) {
    const e = new Error('Missing x-gateway-issued-at') as Error & { code: number };
    e.code = status.UNAUTHENTICATED;
    throw e;
  }
  const actor = firstString(m, GW_METADATA.ACTOR_TYPE).trim();
  if (actor === 'user' && !firstString(m, GW_METADATA.USER_ID).trim()) {
    const e = new Error('Missing x-user-id for user actor') as Error & { code: number };
    e.code = status.UNAUTHENTICATED;
    throw e;
  }
}
