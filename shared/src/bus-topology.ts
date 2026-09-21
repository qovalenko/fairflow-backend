/**
 * Single source of truth for the Fairflow RabbitMQ bus topology — F1-bus
 * (R3/R4/R7). Fixes the production-crash `406 PRECONDITION_FAILED` where
 * different services declared the SAME broker objects with DIFFERENT types/args
 * (e.g. `fairflow.events.dlx` as `topic` in automation but `fanout` in
 * audit/search; consumer work queues declared with vs. without
 * `x-dead-letter-exchange`).
 *
 * EVERY service (relay/publisher, audit, automation, search, notification,
 * billing, any future consumer) MUST declare bus objects through the helpers in
 * this module so the *type* and *arguments* of each exchange/queue are identical
 * across the cluster. Re-declaring an existing object with matching type+args is
 * idempotent in AMQP; mismatching them throws 406 and crashes bootstrap.
 *
 * The module is amqplib-agnostic: it depends only on the tiny
 * {@link TopologyChannel} surface (a subset of an amqplib `Channel`), so it can
 * be unit-tested and wired by any service without a hard amqplib import here.
 *
 * --- AGREED CANONICAL TOPOLOGY (do not diverge per-service) ---
 *  - Main exchange  `fairflow.events`      — type `topic`,  durable.
 *  - Dead-letter    `fairflow.events.dlx`  — type `fanout`, durable.
 *  - Each consumer work queue is durable and dead-letters to the DLX via the
 *    `x-dead-letter-exchange` argument (one value everywhere).
 *  - Terminal DLQ per consumer: `<queue>.dlq`, durable, bound to the DLX (`''`).
 *  - Optional bounded-retry queues: `<queue>.retry.<level>` with `x-message-ttl`
 *    + `x-dead-letter-exchange = ''` (default exchange) + `x-dead-letter-routing-key
 *    = <work queue>` so that on TTL expiry the broker re-delivers the message
 *    STRAIGHT BACK to the work queue (direct via the default exchange). Dead-
 *    lettering a retry queue back to the TOPIC main exchange (as before) produced
 *    an unroutable routing-key `<queue>.retry.<level>` and the message was
 *    SILENTLY DROPPED (F1-bus critical fix).
 */

import { PLATFORM_CONSTANTS } from './platform-constants';

/**
 * --- BUS NAMESPACE (F1b) ---
 *
 * Feature stands (ff-v1, …) and production (the app stand) SHARE one RabbitMQ broker
 * (`rabbitmq.fairflow.svc.cluster.local`, vhost `/`). Without isolation every
 * stand declares the SAME objects (`fairflow.events`, `fairflow.events.dlx`,
 * `automation.triggers`, …) → 406 type/arg clashes + cross-stand event bleed.
 *
 * `BUS_NAMESPACE` prefixes EVERY bus object name (exchanges, DLX, work queues,
 * DLQs, retry queues). It is read once from `process.env.BUS_NAMESPACE`.
 *
 * DEFAULT is `'fairflow'` — i.e. the historical naming — so production the app stand
 * keeps its existing objects untouched. Feature stands set `BUS_NAMESPACE=ff-v1`
 * (etc.) in gitops to get a fully isolated object set on the shared broker.
 *
 * NOTE: nothing here touches the broker — declarations stay idempotent asserts.
 */
export const BUS_NAMESPACE = process.env.BUS_NAMESPACE ?? 'fairflow';

/**
 * Prefix an unqualified bus object base-name with the active {@link BUS_NAMESPACE}.
 *
 * - `busName('events')`               → `fairflow.events`        (prod default)
 * - `busName('automation.triggers')`  → `ff-v1.automation.triggers` (on ff-v1)
 *
 * Use this for the BASE name of every exchange/queue. DLQ/retry suffixes
 * (`.dlq`, `.retry.N`) and the DLX suffix (`.dlx`) are derived from the already
 * namespaced base, so they never need a second prefix.
 */
export function busName(base: string): string {
  return `${BUS_NAMESPACE}.${base}`;
}

/** The default namespace = historical naming; used to keep prod names verbatim. */
export const BUS_NAMESPACE_DEFAULT = 'fairflow';

/**
 * Whether a feature/non-prod namespace is active (anything other than the
 * historical `'fairflow'`). When `true`, consumer work-queue names get the
 * namespace prefix; otherwise they stay exactly as in prod.
 */
export const BUS_NAMESPACE_IS_DEFAULT = BUS_NAMESPACE === BUS_NAMESPACE_DEFAULT;

/**
 * Namespace a CONSUMER WORK-QUEUE base name (e.g. `audit.events`,
 * `automation.triggers`, `search.projection`).
 *
 * Unlike exchanges (whose prod name already begins with `fairflow.`), consumer
 * queues today are NOT prefixed with `fairflow`. To keep prod (default
 * namespace) byte-for-byte identical we leave the name untouched there, and only
 * prefix `<ns>.` on feature stands:
 *
 * - default (`fairflow`): `busQueueName('audit.events')` → `audit.events`
 * - on `ff-v1`:           `busQueueName('audit.events')` → `ff-v1.audit.events`
 *
 * Derived `.dlq` / `.retry.N` suffixes inherit the prefix automatically because
 * they are built from this already-namespaced base.
 */
export function busQueueName(base: string): string {
  return BUS_NAMESPACE_IS_DEFAULT ? base : `${BUS_NAMESPACE}.${base}`;
}

/** Canonical durable topic exchange carrying all domain events (RFC-4 §Р-3). */
export const BUS_MAIN_EXCHANGE = busName('events');

/** Canonical type of the main exchange — `topic` so consumers bind routing-keys. */
export const BUS_MAIN_EXCHANGE_TYPE = 'topic' as const;

/**
 * Canonical durable dead-letter exchange. **Agreed type is `fanout`** — a
 * catch-all that fans every dead-lettered message to whichever DLQs are bound to
 * it. (Previously automation declared this as `topic`, which 406-clashed with
 * audit/search's `fanout`.)
 */
export const BUS_DLX_EXCHANGE = `${BUS_MAIN_EXCHANGE}.dlx`;

/** Canonical type of the DLX — `fanout` (single agreed value, see above). */
export const BUS_DLX_EXCHANGE_TYPE = 'fanout' as const;

/** Argument key used on a work queue to point dead-letters at the DLX. */
export const X_DEAD_LETTER_EXCHANGE = 'x-dead-letter-exchange';
/**
 * Argument key used on a retry queue to force the re-routing key on TTL expiry.
 * Combined with `x-dead-letter-exchange = ''` this delivers the expired message
 * back to the named work queue through the DEFAULT (direct) exchange — instead
 * of re-publishing it to the topic exchange with an unroutable key.
 */
export const X_DEAD_LETTER_ROUTING_KEY = 'x-dead-letter-routing-key';
/** Argument key used on a retry queue to hold a message before re-delivery. */
export const X_MESSAGE_TTL = 'x-message-ttl';

/**
 * Per-message header carrying the number of retry passes so far. The consumer
 * increments it on EVERY hop into a retry queue and reads it to decide the next
 * step. We do NOT count via the broker `x-death[0].count` header — that count is
 * per-`(queue, reason)` and, once a message bounces through the DLX/work-queue
 * loop, its levels skip around and can exceed `maxAttempts`, breaking the bound.
 */
export const X_RETRY_COUNT = 'x-retry-count';

/**
 * Per-message header preserving the ORIGINAL topic routing-key (e.g. `crm.deal.
 * created`). When a message is dead-lettered through a retry queue and returned
 * via the default exchange, its live `fields.routingKey` becomes the WORK QUEUE
 * NAME, not the original event key. Consumers that key off the routing-key
 * (audit / product) read this header via {@link readOriginalRoutingKey}.
 */
export const X_ORIGINAL_ROUTING_KEY = 'x-original-routing-key';

/**
 * Minimal amqplib `Channel` surface this module needs. Declaring it locally
 * keeps `@fairflow/shared` free of an amqplib runtime/type dependency while
 * staying structurally compatible with a real amqplib `Channel`.
 */
export interface TopologyChannel {
  assertExchange(
    exchange: string,
    type: string,
    options?: { durable?: boolean },
  ): Promise<unknown>;
  assertQueue(
    queue: string,
    options?: { durable?: boolean; arguments?: Record<string, unknown> },
  ): Promise<unknown>;
  bindQueue(queue: string, source: string, pattern: string): Promise<unknown>;
}

/** Canonical names for a consumer's queue + DLQ + retry queues. */
export interface BusConsumerTopology {
  /** Live work queue (e.g. `audit.events`, `automation.triggers`). */
  queue: string;
  /** Terminal dead-letter queue bound to the shared DLX. */
  dlq: string;
  /** Shared DLX every DLQ binds to. */
  dlxExchange: string;
  /** Main exchange the work queue binds its routing-keys against. */
  mainExchange: string;
  /** Per-level retry queue name for a 0-based attempt. */
  retryQueue(level: number): string;
  /** Hold TTL (ms) for a 0-based retry attempt. */
  retryDelayMs(level: number): number;
  /** Total retry levels before terminal dead-lettering (FR-NFR-32). */
  maxAttempts: number;
}

/** Build the canonical names for a named consumer queue. */
export function busConsumerTopology(
  queueName: string,
  mainExchange: string = BUS_MAIN_EXCHANGE,
): BusConsumerTopology {
  const levels = PLATFORM_CONSTANTS.DLQ_RETRY_LEVELS_MS;
  return {
    queue: queueName,
    dlq: `${queueName}.dlq`,
    dlxExchange: BUS_DLX_EXCHANGE,
    mainExchange,
    retryQueue: (level: number) => `${queueName}.retry.${level}`,
    retryDelayMs: (level: number) => levels[Math.min(level, levels.length - 1)],
    maxAttempts: levels.length,
  };
}

/**
 * Read the explicit {@link X_RETRY_COUNT} header (0 when absent = first delivery).
 * This is the ONLY source of truth for how many retry passes a message has had —
 * NOT the broker `x-death` header (which is per-`(queue, reason)` and unbounded
 * across the retry-queue ↔ work-queue loop).
 */
export function readRetryCountHeader(
  headers: Record<string, unknown> | undefined,
): number {
  const raw = headers?.[X_RETRY_COUNT];
  const n = typeof raw === 'number' ? raw : Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

/**
 * Read the preserved original topic routing-key. Falls back to the live routing
 * key (first delivery, before any retry hop rewrote it to the work-queue name).
 */
export function readOriginalRoutingKey(
  headers: Record<string, unknown> | undefined,
  liveRoutingKey: string,
): string {
  const raw = headers?.[X_ORIGINAL_ROUTING_KEY];
  return typeof raw === 'string' && raw.length > 0 ? raw : liveRoutingKey;
}

/**
 * Build the headers to attach when sending a message to a retry queue: preserve
 * the existing headers, stamp the ORIGINAL routing key once, and increment the
 * explicit retry counter. `liveRoutingKey` is the message's current routing key
 * (the original event key on first failure, the work-queue name afterwards).
 */
export function buildRetryHeaders(
  headers: Record<string, unknown> | undefined,
  liveRoutingKey: string,
  nextRetryCount: number,
): Record<string, unknown> {
  const base = { ...(headers ?? {}) };
  // Stamp the original key exactly once (first retry pass), keep it thereafter.
  if (typeof base[X_ORIGINAL_ROUTING_KEY] !== 'string') {
    base[X_ORIGINAL_ROUTING_KEY] = liveRoutingKey;
  }
  base[X_RETRY_COUNT] = nextRetryCount;
  return base;
}

/**
 * Idempotently assert the main topic exchange. Call this from EVERY service's
 * channel bootstrap (publishers + consumers) — it is the one place the exchange
 * type is fixed.
 */
export async function assertMainExchange(
  channel: TopologyChannel,
  exchange: string = BUS_MAIN_EXCHANGE,
): Promise<void> {
  await channel.assertExchange(exchange, BUS_MAIN_EXCHANGE_TYPE, { durable: true });
}

/**
 * Idempotently assert the shared dead-letter exchange with its canonical
 * `fanout` type. Safe to call from any consumer; identical args everywhere.
 */
export async function assertDlxExchange(channel: TopologyChannel): Promise<void> {
  await channel.assertExchange(BUS_DLX_EXCHANGE, BUS_DLX_EXCHANGE_TYPE, {
    durable: true,
  });
}

/** Options for {@link assertConsumerTopology}. */
export interface AssertConsumerTopologyOptions {
  /** Routing-keys to bind the work queue to on the main exchange. */
  routingKeys: string[];
  /**
   * Also declare the per-level bounded-retry queues (audit reference impl).
   * Defaults to `false`: most consumers only need work-queue → DLX → DLQ.
   */
  withRetryQueues?: boolean;
  /** Extra arguments to merge onto the work queue (e.g. quorum/length limits). */
  queueArguments?: Record<string, unknown>;
}

/**
 * Idempotently assert a consumer's full topology with the agreed shape so it can
 * never 406-clash with another service:
 *
 *   main exchange (topic) ──routing-keys──▶ <queue> (durable, DLX=fairflow.events.dlx)
 *   <queue> ──nack/expire──▶ fairflow.events.dlx (fanout) ──▶ <queue>.dlq
 *
 * The work queue ALWAYS carries `x-dead-letter-exchange = fairflow.events.dlx`
 * — this is the single agreed value, so a queue declared by one service matches
 * the same queue declared by another.
 *
 * @returns the resolved {@link BusConsumerTopology} (names) for the caller.
 */
export async function assertConsumerTopology(
  channel: TopologyChannel,
  queueName: string,
  options: AssertConsumerTopologyOptions,
  mainExchange: string = BUS_MAIN_EXCHANGE,
): Promise<BusConsumerTopology> {
  const topology = busConsumerTopology(queueName, mainExchange);

  await assertMainExchange(channel, mainExchange);
  await assertDlxExchange(channel);

  // Terminal DLQ — fanout DLX binds with the empty pattern.
  await channel.assertQueue(topology.dlq, { durable: true });
  await channel.bindQueue(topology.dlq, topology.dlxExchange, '');

  if (options.withRetryQueues) {
    for (let level = 0; level < topology.maxAttempts; level += 1) {
      // On TTL expiry the message must go BACK to the work queue, not to the
      // topic exchange with an unroutable `<queue>.retry.<level>` key. Use the
      // default (direct) exchange (`''`) + a fixed routing key = the work queue
      // name so RabbitMQ delivers it straight to the work queue for re-attempt.
      await channel.assertQueue(topology.retryQueue(level), {
        durable: true,
        arguments: {
          [X_MESSAGE_TTL]: topology.retryDelayMs(level),
          [X_DEAD_LETTER_EXCHANGE]: '',
          [X_DEAD_LETTER_ROUTING_KEY]: topology.queue,
        },
      });
    }
  }

  // Work queue — ALWAYS dead-letters to the shared DLX (single agreed arg).
  await channel.assertQueue(topology.queue, {
    durable: true,
    arguments: {
      [X_DEAD_LETTER_EXCHANGE]: topology.dlxExchange,
      ...(options.queueArguments ?? {}),
    },
  });
  for (const key of options.routingKeys) {
    await channel.bindQueue(topology.queue, mainExchange, key);
  }

  return topology;
}
