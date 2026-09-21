/**
 * Transactional outbox — RFC-4 §Р-1/§Р-3/§Р-4, IMPLEMENTATION-DEBT Д-1 (E3-01).
 *
 * The outbox guarantees the invariant **"no business record without an event,
 * and no event without a business record"**: a domain writes its business
 * mutation and an outbox row in ONE storage transaction (Mongo session for the
 * CRM domains, a single Prisma tx for PG domains). A background relay then reads
 * unpublished rows and publishes them to the broker **at-least-once**, marking
 * each row published only after the broker acks. Consumers dedup on the
 * envelope's `idempotencyKey ?? messageId` (RFC-4 §Р-4).
 *
 * This module is **storage-agnostic & transport-agnostic typing + helpers**:
 *  - the {@link OutboxRow} shape & {@link OutboxStatus} lifecycle,
 *  - {@link buildOutboxRow} — turns an emit intent into a row + canonical
 *    `EventEnvelope` (validates the routing-key via {@link assertPublishKey}),
 *  - {@link OutboxPublisher}/{@link OutboxStore}/{@link OutboxRelay} contracts a
 *    domain implements against its own storage + broker.
 *
 * Reference implementations live in the domains (contact, pipe). The bulk emit
 * wiring across all ~100 keys is E3-02, out of scope here.
 */

import { uuidv7 } from 'uuidv7';
import { busName } from './bus-topology';
import { EVENT_VERSION, MAX_EVENT_DEPTH, type EventActorType, type EventEnvelope } from './events';
import { assertPublishKey } from './routing-keys';

/**
 * Outbox row lifecycle (RFC-4 §Р-4, at-least-once):
 *  - `pending`   — written in the business tx, not yet published;
 *  - `published` — broker acked at least once (terminal happy path);
 *  - `failed`    — exhausted relay attempts; needs DLQ/operator (E3-06).
 */
export type OutboxStatus = 'pending' | 'published' | 'failed';

/**
 * Default broker exchange for Fairflow domain events (topic, durable).
 * Namespaced via {@link busName} (F1b) — `<BUS_NAMESPACE>.events`, default
 * `fairflow.events`. Same object as {@link BUS_MAIN_EXCHANGE}.
 */
export const OUTBOX_EXCHANGE = busName('events');

/** Relay defaults (overridable per-domain; hard NFR retention/DLQ is E3-06). */
export const OUTBOX_RELAY_DEFAULTS = {
  /** Rows pulled per relay tick. */
  batchSize: 100,
  /** Poll interval (ms) when there is nothing to publish. */
  pollIntervalMs: 1_000,
  /** Max publish attempts before a row is marked `failed`. */
  maxAttempts: 8,
} as const;

/**
 * One transactional-outbox row. Stored in the emitter's own storage (a
 * `_outbox` collection for Mongo domains, an `outbox` table for PG domains) and
 * written in the SAME transaction as the business mutation.
 *
 * The row carries the fully-built {@link EventEnvelope} so the relay is a dumb
 * pump — it never re-derives event shape. `messageId === envelope.messageId`
 * (the broker `messageId` for transport dedup, RFC-4 §Р-4).
 */
export interface OutboxRow<T = unknown> {
  /** Row id; equals `envelope.messageId` (UUIDv7) — broker transport dedup. */
  messageId: string;
  /** Routing-key === `envelope.type` (RFC-4 §Р-3). Duplicated for cheap querying. */
  routingKey: string;
  /** Tenant/project scope, duplicated for ops/partition queries. */
  projectId?: string;
  /** Lifecycle status (RFC-4 §Р-4). */
  status: OutboxStatus;
  /** Publish attempts so far (incremented by the relay). */
  attempts: number;
  /** The canonical event envelope to publish verbatim. */
  envelope: EventEnvelope<T>;
  /** Last publish error (when `attempts > 0` / `status === 'failed'`). */
  lastError?: string;
  /** When the row was created (in the business tx). */
  createdAt: Date;
  /** When the relay last touched the row. */
  updatedAt: Date;
  /** When the broker acked (status → published). */
  publishedAt?: Date;
}

/** Causation context propagated from an inbound event/request (RFC-4 §Р-1). */
export interface OutboxCausation {
  /** Root of the causation chain; inherited downstream. */
  traceId?: string;
  /** `messageId` of the parent event (this event's cause). */
  causationId?: string;
  /** Parent depth; the new envelope gets `min(MAX_EVENT_DEPTH, depth+1)`. */
  parentDepth?: number;
}

/** Inputs to {@link buildOutboxRow} — a single emit intent from a domain. */
export interface EmitIntent<T = unknown> {
  /** Canonical routing-key (validated against the RFC-4 §Р-3 registry). */
  type: string;
  /** Event payload (no secrets; `before?`/`after?` per RFC-4). */
  payload: T;
  /** Publisher domain (`EVENT_SOURCE_DOMAINS`). */
  source: string;
  /** Tenant/project scope (isolation; almost always set for CRM facts). */
  projectId?: string;
  /**
   * Business idempotency key (RFC-4 §Р-1, SHOULD be set). For sagas use a stable
   * business key, e.g. `dealId:wonVersion`. Falls back to `messageId` for dedup.
   */
  idempotencyKey?: string;
  /** `<entityType>/<entityId>` (RFC-4 §Р-1). */
  subject?: string;
  /** User who triggered the action (when actor is a user). */
  userId?: string;
  /** Actor classification (RFC-4 §Р-1). */
  actorType?: EventActorType;
  /** Payload-schema version; defaults to {@link EVENT_VERSION}. */
  version?: number;
  /** URI/version of the payload schema (RFC-4 §Р-1). */
  dataschema?: string;
  /** Inbound causation to chain from (lineage). */
  causation?: OutboxCausation;
  /** Override the generated `messageId` (tests / explicit dedup). */
  messageId?: string;
  /** Override `createdAt`/`updatedAt` (tests). */
  now?: Date;
}

/**
 * Build a ready-to-store {@link OutboxRow} (with its {@link EventEnvelope}) from
 * an emit intent. Validates the routing-key against the canonical registry
 * (throws on an unregistered/malformed key, RFC-4 §Р-5) so an illegal key can
 * never enter the outbox.
 */
export function buildOutboxRow<T>(intent: EmitIntent<T>): OutboxRow<T> {
  // Fail fast: never persist an outbox row for an illegal/unregistered key.
  assertPublishKey(intent.type);

  const messageId = intent.messageId ?? uuidv7();
  const now = intent.now ?? new Date();
  const depth =
    intent.causation?.parentDepth === undefined
      ? 0
      : Math.min(MAX_EVENT_DEPTH, intent.causation.parentDepth + 1);

  const envelope: EventEnvelope<T> = {
    type: intent.type,
    version: intent.version ?? EVENT_VERSION,
    messageId,
    idempotencyKey: intent.idempotencyKey ?? messageId,
    timestamp: now.toISOString(),
    source: intent.source,
    traceId: intent.causation?.traceId ?? messageId,
    causationId: intent.causation?.causationId,
    depth,
    projectId: intent.projectId,
    userId: intent.userId,
    actorType: intent.actorType,
    subject: intent.subject,
    dataschema: intent.dataschema,
    payload: intent.payload,
  };

  return {
    messageId,
    routingKey: intent.type,
    projectId: intent.projectId,
    status: 'pending',
    attempts: 0,
    envelope,
    createdAt: now,
    updatedAt: now,
  };
}

/** Transport dedup key for a row/envelope (RFC-4 §Р-4). */
export function dedupKey(envelope: Pick<EventEnvelope, 'idempotencyKey' | 'messageId'>): string {
  return envelope.idempotencyKey ?? envelope.messageId;
}

/**
 * Broker publisher contract the relay depends on (implemented per-domain over
 * amqplib or shared infra). MUST resolve only after the broker confirms/acks the
 * message; rejecting/throwing leaves the row `pending` for retry (at-least-once).
 */
export interface OutboxPublisher {
  publish(envelope: EventEnvelope): Promise<void>;
}

/**
 * Storage contract for the relay — implemented per-domain over its own storage
 * (Mongo `_outbox` collection / PG `outbox` table). The relay only needs to
 * read pending rows and flip their status; the business write path uses the
 * native transaction to insert rows alongside the business mutation.
 */
export interface OutboxStore {
  /** Fetch up to `limit` `pending` rows oldest-first (FIFO-ish). */
  fetchPending(limit: number): Promise<OutboxRow[]>;
  /** Mark a row published (broker acked) — terminal. */
  markPublished(messageId: string, at: Date): Promise<void>;
  /** Bump attempts after a failed publish; flip to `failed` past `maxAttempts`. */
  markAttemptFailed(
    messageId: string,
    error: string,
    at: Date,
    maxAttempts: number,
  ): Promise<void>;
}

/** Relay tunables. */
export interface OutboxRelayOptions {
  batchSize?: number;
  pollIntervalMs?: number;
  maxAttempts?: number;
}

/** Outcome of one relay tick (for metrics/logging/tests). */
export interface OutboxRelayTickResult {
  fetched: number;
  published: number;
  failed: number;
}

/**
 * Generic, storage-agnostic relay loop. A domain wires its {@link OutboxStore}
 * (own storage) + {@link OutboxPublisher} (own broker channel) and drives this:
 * call {@link tick} from a timer/interval. Publishing is **at-least-once** — a
 * crash between broker-ack and `markPublished` re-publishes the row on the next
 * tick; consumers dedup on {@link dedupKey}.
 */
export class OutboxRelay {
  private readonly opts: Required<OutboxRelayOptions>;

  constructor(
    private readonly store: OutboxStore,
    private readonly publisher: OutboxPublisher,
    options: OutboxRelayOptions = {},
  ) {
    this.opts = {
      batchSize: options.batchSize ?? OUTBOX_RELAY_DEFAULTS.batchSize,
      pollIntervalMs: options.pollIntervalMs ?? OUTBOX_RELAY_DEFAULTS.pollIntervalMs,
      maxAttempts: options.maxAttempts ?? OUTBOX_RELAY_DEFAULTS.maxAttempts,
    };
  }

  get pollIntervalMs(): number {
    return this.opts.pollIntervalMs;
  }

  /** Publish one batch of pending rows. Safe to call repeatedly. */
  async tick(): Promise<OutboxRelayTickResult> {
    const rows = await this.store.fetchPending(this.opts.batchSize);
    let published = 0;
    let failed = 0;
    for (const row of rows) {
      const now = new Date();
      try {
        await this.publisher.publish(row.envelope);
        // Ack first, then mark — a crash here only causes a (deduped) re-publish.
        await this.store.markPublished(row.messageId, now);
        published += 1;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        await this.store.markAttemptFailed(row.messageId, message, now, this.opts.maxAttempts);
        failed += 1;
      }
    }
    return { fetched: rows.length, published, failed };
  }
}
