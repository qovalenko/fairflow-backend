/**
 * Who/what triggered the event (RFC-4 Р-1).
 */
export type EventActorType = 'user' | 'service' | 'system' | 'partner';

/**
 * Event envelope for domain events over RabbitMQ (or other broker).
 * Canonical flat shape per RFC-4 §Р-1 (FR-EVT-1): plain causation
 * (`causationId` + `depth` + `traceId`); the nested `causation{path[],depth}`
 * form is forbidden. Lineage is reconstructed via `traceId`/`causationId`.
 *
 * Transport dedup key = `idempotencyKey ?? messageId` (RFC-4 §Р-4). There is no
 * `eventId` field.
 */
export interface EventEnvelope<T = unknown> {
  /** Event type === routing-key, e.g. `crm.contact.created` (RFC-4 §Р-3). */
  type: string;
  /** Payload-schema version for evolution. NOT part of the routing-key. */
  version: number;
  /** Globally-unique message id (UUIDv7) — transport dedup. */
  messageId: string;
  /**
   * Business idempotency key. RFC-4 §Р-1 marks this mandatory; kept optional in
   * the type for backward compatibility, producers SHOULD always set it (for
   * sagas use a stable business key). Consumers dedup on `idempotencyKey ?? messageId`.
   */
  idempotencyKey?: string;
  /** When the event was produced (ISO8601). */
  timestamp: string;
  /** Source publisher domain (see `EVENT_SOURCE_DOMAINS`). */
  source: string;
  /** Root of the causation chain (lineage). */
  traceId?: string;
  /** `messageId` of the parent event in the chain (RFC-4 §Р-1). */
  causationId?: string;
  /** Depth counter of the causation chain, default 0 (RFC-4 §Р-1, FR-EVT-9). */
  depth?: number;
  /** Tenant/project scope. */
  projectId?: string;
  /** Optional user id who triggered the action. */
  userId?: string;
  /** Actor classification (RFC-4 §Р-1). */
  actorType?: EventActorType;
  /** `<entityType>/<entityId>` (RFC-4 §Р-1). */
  subject?: string;
  /** URI/version of the payload schema (RFC-4 §Р-1). */
  dataschema?: string;
  /** Payload (`before?`/`after?`, no secrets). */
  payload: T;
}

export const EVENT_VERSION = 1;

/**
 * Single envelope-level causation-chain depth limit (RFC-4 §Р-1, FR-EVT-9).
 * Domain throttles may be stricter but never override this; apply `min(16, X)`.
 */
export const MAX_EVENT_DEPTH = 16;
