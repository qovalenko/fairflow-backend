/**
 * Single source of truth for cross-cutting platform constants — FR-NFR-1
 * (cross-cutting-nfr/TZ §5.1). Areas **import** these values, they do NOT
 * re-declare them locally: a local literal copy of any of these keys is a
 * cross-cutting drift (the documented billing(60s)↔guard(30s) hole, NFR-BILL-9).
 *
 * Values here are the **resolved** cross-area values (the survey lowered the
 * billing snapshot TTL to the guard TTL, renamed JWT_EXPIRE→refresh, etc.).
 * When a cross-area conflict is resolved, the value is fixed here and the area
 * deletes its literal (FR-NFR-1, "back-propagation").
 *
 * The object is `as const` so a re-declaration / divergent local copy is caught
 * by the type-checker, not by a brittle grep over magic numbers.
 */
export const PLATFORM_CONSTANTS = {
  // --- Cache freshness (TTL = ceiling; event-driven invalidation is primary) ---
  /** Project-access snapshot cache ceiling (guard-cache AS-IS). */
  PROJECT_ACCESS_CACHE_TTL_MS: 30_000,
  /**
   * Gateway module-guard effective-modules cache when cross-pod Redis fanout is
   * active (invalidation is near-instant; TTL is a safety net only).
   */
  MODULE_CACHE_TTL_WITH_FANOUT_MS: 30_000,
  /**
   * Gateway module-guard cache when cross-pod fanout is inactive — shorter bound
   * so a stale module set cannot outlive 5s per pod (NFR-010).
   */
  MODULE_CACHE_TTL_FALLBACK_MS: 5_000,
  /** Billing snapshot cache ceiling — lowered from 60_000 to the guard TTL (NFR-BILL-9). */
  BILLING_SNAPSHOT_CACHE_TTL_MS: 30_000,
  /** Permission-set (read/write) snapshot cache ceiling. */
  PERMISSION_SET_CACHE_TTL_MS: 30_000,
  /** Destructive (delete/manage) permission cache — always recompute. */
  PERMISSION_DESTRUCTIVE_CACHE_TTL_MS: 0,
  /** Partner scoped-token cache ceiling (revoke ≤30s). */
  PARTNER_TOKEN_CACHE_TTL_MS: 30_000,
  /** NFR-AUTH-030: contract ceiling for service-API-key validation cache (consumers clamp to this). */
  SERVICE_API_KEY_CACHE_TTL_MS: 60_000,
  /** Partner broker-token (class B) TTL. */
  PARTNER_BROKER_TOKEN_TTL_MS: 300_000,

  // --- Auth token lifetimes (FR-NFR-30 — short access-TTL enables fail-open denylist) ---
  /** Access-token TTL; short → fail-open denylist allowed (window ≤ 15m). */
  JWT_ACCESS_EXPIRE: '15m',
  /** Refresh-session TTL (formerly JWT_EXPIRE). NOT the access-token TTL. */
  JWT_REFRESH_EXPIRE: '7d',

  // --- Retention (canon §17; defaults fixed, periods configurable within limits) ---
  /** soft-delete grace before archival (restorable by Admin+). */
  RETENTION_SOFT_DELETE_DAYS: 7,
  /** read-only archive window before hard-delete eligibility. */
  RETENTION_ARCHIVE_MONTHS: 6,
  /** delay after archival before hard-delete (body + PII erased). */
  RETENTION_HARD_DELETE_AFTER_ARCHIVE_MONTHS: 12,
  /** merge shadow-copy TTL (rollback window, Admin+). */
  MERGE_SHADOW_TTL_DAYS: 30,

  // --- Eventing / outbox / DLQ (FR-NFR-31/32/34) ---
  /** Relay publish-latency ceiling after commit (NFR-EVT-4, NFR-LIFE-10). */
  OUTBOX_RELAY_MAX_LATENCY_MS: 2_000,
  /**
   * Consumer retry back-off levels before dead-lettering (canon §8.8). A message
   * that fails is re-delivered after these delays; once exhausted it goes to the
   * DLQ instead of a silent `nack(requeue=false)` (FR-NFR-32, blocker FR-NFR-3).
   */
  DLQ_RETRY_LEVELS_MS: [30_000, 60_000, 300_000] as readonly number[],
  /** Idempotency dedup ledger TTL — ≥ retry window (consumer-side dedup, FR-NFR-33). */
  IDEMPOTENCY_DEDUP_TTL_MS: 7 * 24 * 60 * 60 * 1_000,

  // --- Observability / integrity ---
  /** Hash-chain integrity-verifier schedule ceiling (NFR-EVT-6). */
  AUDIT_HASH_CHAIN_VERIFY_INTERVAL_MS: 24 * 60 * 60 * 1_000,

  // --- Pagination (FR-NFR-9; safe default ceiling for unbounded queries) ---
  /** Default page size when a list request omits a limit. */
  DEFAULT_PAGE_LIMIT: 50,
  /** Hard upper bound on a single page (reject above this). */
  MAX_PAGE_LIMIT: 100,
} as const;

export type PlatformConstants = typeof PLATFORM_CONSTANTS;

/** Convenience: retry levels as a mutable array for amqplib delay wiring. */
export function dlqRetryLevelsMs(): number[] {
  return [...PLATFORM_CONSTANTS.DLQ_RETRY_LEVELS_MS];
}
