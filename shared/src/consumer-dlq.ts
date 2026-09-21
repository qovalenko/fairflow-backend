/**
 * Consumer-side DLQ + retry contract — FR-NFR-32/34, FR-EVT-7 (cross-cutting-nfr
 * §4.8, audit-contract §5.1 [SEC integrity]).
 *
 * The AS-IS audit consumer dead-dropped failed messages with a silent
 * `nack(message, false, false)` — a gap in the chain that is indistinguishable
 * from malicious deletion (audit-contract §5.1). The platform invariant
 * (FR-NFR-3, blocker) is: **`nack(requeue=false)` without a DLQ is forbidden**.
 *
 * This module is amqplib-agnostic: it owns the **topology naming** and the
 * **retry decision** (how many attempts, what delay). Domains wire the actual
 * channel assertions / `publish` calls; the audit consumer is the reference
 * implementation (E3-06).
 */

import { busName, readRetryCountHeader } from './bus-topology';
import { PLATFORM_CONSTANTS } from './platform-constants';

/**
 * Default broker exchange (mirrors {@link OUTBOX_EXCHANGE}). Namespaced via
 * {@link busName} (F1b) — `<BUS_NAMESPACE>.events`, default `fairflow.events`.
 */
export const DLQ_DEFAULT_EXCHANGE = busName('events');

/**
 * RabbitMQ topology for a consumer queue with bounded retries + a terminal DLQ.
 *
 * - `queue`       — the live work queue (bound to the routing-keys);
 * - `retryQueue`  — a per-level holding queue with `x-message-ttl` +
 *   `x-dead-letter-exchange = ''` + `x-dead-letter-routing-key = <work queue>`,
 *   so on TTL expiry the message returns DIRECTLY to the work queue (delayed
 *   re-delivery) rather than to the topic exchange with an unroutable key;
 * - `dlqExchange` / `dlq` — terminal dead-letters once retries are exhausted.
 *
 * Naming is derived from the consumer name so multiple consumers don't collide.
 */
export interface ConsumerDlqTopology {
  /** Live work queue (e.g. `audit.events`). */
  queue: string;
  /** Terminal dead-letter exchange (fanout/topic, durable). */
  dlqExchange: string;
  /** Terminal dead-letter queue bound to {@link dlqExchange} (`#`). */
  dlq: string;
  /** Per-level retry queue name for a given 0-based retry attempt. */
  retryQueue(level: number): string;
  /** TTL (ms) to hold a message before re-delivery for a 0-based attempt. */
  retryDelayMs(level: number): number;
  /** Total retry levels available before dead-lettering (FR-NFR-32). */
  maxAttempts: number;
}

/** Build the canonical DLQ topology for a named consumer queue. */
export function consumerDlqTopology(
  queueName: string,
  exchange: string = DLQ_DEFAULT_EXCHANGE,
): ConsumerDlqTopology {
  const levels = PLATFORM_CONSTANTS.DLQ_RETRY_LEVELS_MS;
  return {
    queue: queueName,
    dlqExchange: `${exchange}.dlx`,
    dlq: `${queueName}.dlq`,
    retryQueue: (level: number) => `${queueName}.retry.${level}`,
    retryDelayMs: (level: number) => levels[Math.min(level, levels.length - 1)],
    maxAttempts: levels.length,
  };
}

/** What a consumer should do with a failed message (next step in the retry ladder). */
export type DlqDecision =
  | { kind: 'retry'; level: number; delayMs: number }
  | { kind: 'dead_letter' };

/**
 * Decide the fate of a failed message given how many times it has already been
 * retried. `attempt` is the 0-based count of prior failed deliveries (read from
 * the AMQP `x-death` header or a per-message counter). Once attempts reach
 * `maxAttempts`, the message is dead-lettered — never silently dropped.
 */
export function dlqDecision(
  attempt: number,
  topology: Pick<ConsumerDlqTopology, 'maxAttempts' | 'retryDelayMs'>,
): DlqDecision {
  if (attempt < topology.maxAttempts) {
    return { kind: 'retry', level: attempt, delayMs: topology.retryDelayMs(attempt) };
  }
  return { kind: 'dead_letter' };
}

/**
 * Read the prior retry count from an AMQP message. Returns 0 when absent (first
 * delivery).
 *
 * IMPORTANT: this reads the EXPLICIT `x-retry-count` header the consumer stamps
 * on each retry hop — NOT the broker `x-death[0].count`. `x-death` counts are
 * per-`(queue, reason)`; once a message bounces through the retry-queue → work-
 * queue loop those counts skip around and exceed `maxAttempts`, which would let
 * a poison message either die too early or (worse) loop unbounded. The explicit
 * counter is monotonic per-message and bounds the ladder exactly.
 */
export function readRetryCount(headers: Record<string, unknown> | undefined): number {
  return readRetryCountHeader(headers);
}
