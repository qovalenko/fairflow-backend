/**
 * gRPC metadata keys (lower-case per policy).
 *
 * CANON (decision X-7, P8): this map is the SINGLE source of truth for all `x-*`
 * gateway→domain metadata keys. New keys are added ONLY here (and read via the shared
 * inbound/outbound helpers) — never hard-coded as string literals elsewhere.
 */
export const GW_METADATA = {
  REQUEST_ID: 'x-request-id',
  TRACE_ID: 'x-trace-id',
  TRACEPARENT: 'traceparent',
  USER_ID: 'x-user-id',
  ACTOR_TYPE: 'x-actor-type',
  ORG_ID: 'x-org-id',
  PROJECT_ID: 'x-project-id',
  ROLES: 'x-roles',
  PERMISSIONS: 'x-permissions',
  SESSION_ID: 'x-session-id',
  GATEWAY_ISSUED_AT: 'x-gateway-issued-at',
  GATEWAY_API_KEY_ID: 'x-gateway-api-key-id',
  SERVICE_API_KEY: 'x-service-api-key',
  IDEMPOTENCY_KEY: 'idempotency-key',
  /**
   * Server-generated identifier of ONE gateway→domain gRPC call (TODO-475).
   *
   * Unlike REQUEST_ID (`x-request-id` is echoed from the CLIENT header when present)
   * and IDEMPOTENCY_KEY (client-supplied by definition), this value is minted with
   * `randomUUID()` on every outbound-metadata build and can NOT be pinned by the
   * caller. Domains use it as the dedup key of audit/outbox FACTS: a transport
   * retry of the same call reuses the same metadata (same call-id → one fact),
   * while two deliberate user actions are always two facts even if the client sent
   * a fixed `X-Request-Id`. NEVER read a client header into this key.
   */
  CALL_ID: 'x-gw-call-id',
  ENABLED_MODULES: 'x-enabled-modules',
  MODULE_POLICY_SNAPSHOT: 'x-module-policy-snapshot',
  VISIBILITY_SCOPE: 'x-visibility-scope',
  /** Compiled ABAC predicate resolved on the gateway (base64(JSON{ mongo })),
   * AND-ed by domains into their read filter — draft, depends on v1/ABAC (RFC-5). */
  ACCESS_PREDICATE: 'x-access-predicate',
  /** org-overview (E4-31, FR-OV-26): organization boundary of the cross-project
   * viewer; first key of every OrgRollup index. Set ONLY by the gateway after it
   * resolved org membership — domains read it from metadata, never the body. */
  ORGANIZATION_ID: 'x-organization-id',
  /** chat (M-CHAT-10, B-3): the individual-mode workspace boundary. For users
   * without a corporate organization, DM/group conversations are isolated by
   * `(workspace)` instead of `(organization)`. Set ONLY by the gateway from the
   * resolved session — domains read it from metadata, never the body. Required
   * for the chat domain's `(org|workspace)` scope (contracts/chat.md §1/§2.2). */
  WORKSPACE_ID: 'x-workspace-id',
  /** Structured error details channel (domain → gateway). Trailing gRPC metadata
   * carrying a JSON payload `{ code, violations|errors }` so structured validation
   * failures survive as first-class `details` instead of being JSON-encoded into
   * the human-readable status message. `-bin` suffix marks it as binary per gRPC. */
  ERROR_DETAILS: 'x-error-details-bin',
} as const;
