import { dlqRetryLevelsMs } from '@fairflow/shared';
import { isTransientExecutorError } from './executors/executor-errors';
import { EMAIL_TRANSIENT_ERROR } from './executors/email-executor';
import { EXTERNAL_EFFECT_ACTIONS } from './registry';

/**
 * Pure DLQ-retry policy: row shape, backoff ladder, attempt cap, retryability
 * and the fresh-generation idempotency key.
 *
 * Deliberately free of Nest/Mongo so BOTH `ActionDispatcher` (which schedules the
 * first auto-retry when it writes a DLQ row) and `DlqRetryService` (which runs
 * them) can import it without a circular module dependency.
 */

/** DLQ row shape this service reads/writes (mirrors `AutomationService.DlqDoc`). */
export interface DlqRow {
  id: string;
  project_id: string;
  execution_id: string;
  rule_id: string;
  action_index?: number;
  action_type: string;
  action_config_json?: string;
  connection_id?: string;
  payload_json?: string;
  /**
   * Actor of the ORIGINAL dispatch (`user` | `system`), plus the caller identity
   * it ran under. Replayed as-is by the retry engine so a retry can never widen
   * the visibility of the run that failed (§3.8). Rows written before this field
   * existed have no actor — they are replayed as `user` (fail-closed).
   */
  actor?: string;
  actor_user_id?: string;
  actor_visibility_scope?: string;
  status: string;
  attempts: number;
  last_error?: string;
  last_http_code?: number;
  next_retry_at?: number;
  /** Retry generation: bumped on EVERY re-dispatch (see {@link freshIdempotencyKey}). */
  retry_generation?: number;
  max_attempts?: number;
  created_at: number;
  updated_at: number;
}

/** Terminal state of a row whose retry budget is spent (no more auto-retries). */
export const DLQ_EXHAUSTED = 'exhausted';

/** Statuses a manual retry may be started from. */
export const DLQ_MANUAL_RETRYABLE = new Set(['failed', DLQ_EXHAUSTED]);

/** Default attempt cap; `attempts` counts every dispatch including the first. */
export function maxAttempts(row?: Pick<DlqRow, 'max_attempts'>): number {
  const fromRow = Number(row?.max_attempts);
  if (Number.isFinite(fromRow) && fromRow > 0) return Math.trunc(fromRow);
  const env = Number(process.env.AUTOMATION_DLQ_MAX_ATTEMPTS ?? 5);
  return Number.isFinite(env) && env > 0 ? Math.trunc(env) : 5;
}

/**
 * Exponential backoff for auto-retry attempt `attempt` (1-based).
 *
 * Starts on the platform's shared consumer ladder (30s → 60s → 300s, so DLQ
 * re-sends pace exactly like bus redeliveries) and keeps doubling from the last
 * level for the remaining attempts, capped at an hour.
 */
export function backoffMs(attempt: number): number {
  const levels = dlqRetryLevelsMs();
  const cap = Number(process.env.AUTOMATION_DLQ_BACKOFF_CAP_MS ?? 3_600_000) || 3_600_000;
  const idx = Math.max(1, Math.trunc(attempt)) - 1;
  if (idx < levels.length) return Math.min(levels[idx], cap);
  const extra = idx - levels.length + 1;
  return Math.min(levels[levels.length - 1] * 2 ** extra, cap);
}

/**
 * Is another attempt worth making? Config errors (`connection_not_found…`,
 * `*_rejected:*`, HTTP 4xx) are NOT auto-retried — hammering them only burns the
 * budget and buries the real cause. Manual retry stays available for all of them.
 */
export function isRetryableFailure(error: string, httpCode?: number): boolean {
  const code = Number(httpCode ?? 0);
  if (code >= 400 && code < 500) return false;
  if (code >= 500) return true;
  const e = String(error ?? '');
  if (!e) return false;
  if (isTransientExecutorError(e) || e.startsWith(EMAIL_TRANSIENT_ERROR)) return true;
  if (/^http_5\d\d$/.test(e)) return true;
  if (e === 'timeout' || e === 'breaker_open') return true;
  return /ECONNREFUSED|ECONNRESET|ENOTFOUND|EAI_AGAIN|EPIPE|ETIMEDOUT|socket hang up|fetch failed/i.test(
    e,
  );
}

/**
 * Attempt cap for an AMBIGUOUS outcome (see {@link isAmbiguousDelivery}) of an
 * external-effect action. `2` = the first delivery plus exactly one automatic
 * re-send; everything beyond that is a human decision.
 */
export function ambiguousMaxAttempts(): number {
  const env = Number(process.env.AUTOMATION_DLQ_AMBIGUOUS_MAX_ATTEMPTS ?? 2);
  return Number.isFinite(env) && env > 0 ? Math.trunc(env) : 2;
}

/**
 * Did the failure leave the outcome UNKNOWN — i.e. the request was already on
 * the wire when it broke?
 *
 * "Retryable" and "definitely did not happen" are not the same thing, and the
 * DLQ ladder used to conflate them: a webhook that was accepted and processed
 * but answered a millisecond after `AUTOMATION_WEBHOOK_TIMEOUT_MS` reports
 * `timeout`, which is retryable — so the receiver got the SAME body up to four
 * more times, now without a human in the loop. A refused connection or an
 * unresolvable host is different in kind: nothing was delivered, replaying is
 * free.
 *
 * Ambiguity is therefore a separate axis from retryability: it does not stop the
 * retry, it BOUNDS it ({@link attemptCapFor}) for the actions whose effect
 * leaves this process (`send_webhook`, `send_email`). An HTTP status means the
 * peer answered — the outcome is known, ambiguity does not apply.
 */
export function isAmbiguousDelivery(error: string, httpCode?: number): boolean {
  if (Number(httpCode ?? 0) >= 100) return false;
  const e = String(error ?? '');
  if (!e) return false;
  // `breaker_open` / `connection_*` / `*_target_*` are pre-send refusals: the
  // request never left, so they are unambiguous by construction.
  if (/breaker_open|connection_unavailable|not_configured|target_invalid/i.test(e)) return false;
  return /timeout|ETIMEDOUT|ECONNRESET|EPIPE|socket hang up|fetch failed|abort|DEADLINE_EXCEEDED|deadline/i.test(
    e,
  );
}

/**
 * Effective attempt cap for a row given how its last attempt failed: the row's
 * own budget, narrowed to {@link ambiguousMaxAttempts} when an EXTERNAL-effect
 * action failed ambiguously. Plain CRM actions keep the full ladder — their
 * mutations are re-applied against a domain that can dedup/no-op them, whereas
 * an email or a webhook body cannot be un-sent.
 */
export function attemptCapFor(
  row: Pick<DlqRow, 'max_attempts' | 'action_type'>,
  error: string,
  httpCode?: number,
): number {
  const cap = maxAttempts(row);
  if (!EXTERNAL_EFFECT_ACTIONS.has(String(row.action_type ?? ''))) return cap;
  if (!isAmbiguousDelivery(error, httpCode)) return cap;
  return Math.min(cap, ambiguousMaxAttempts());
}

/**
 * Mint a FRESH idempotency key for a re-dispatch, using the project's
 * two-generation scheme `…:<payloadGen>:<sendGen>` (orders' `finalActionState`).
 *
 * THIS IS THE RAKE THIS FILE EXISTS FOR. The previous retry implementation
 * replayed the stored payload verbatim, so the re-sent action carried the SAME
 * `idempotency_key`; the receiving side recognised it as a duplicate, did
 * nothing, answered "already handled" — and the order it was supposed to unstick
 * stayed in SENDING. A retry that cannot be told apart from the delivery it is
 * retrying is not a retry.
 *
 * `payloadGen` is preserved (the payload did not change), `sendGen` advances by
 * the retry generation. A key without the two trailing generations gets them.
 */
export function freshIdempotencyKey(key: string, generation: number): string {
  const gen = Math.max(1, Math.trunc(generation));
  const match = /^(.*):(\d+):(\d+)$/.exec(key);
  if (match) {
    const payloadGen = Number(match[2]);
    const sendGen = Number(match[3]) + gen;
    return `${match[1]}:${payloadGen}:${sendGen}`;
  }
  return `${key}:1:${1 + gen}`;
}

/**
 * Rewrite every idempotency marker in a replayed payload to the new generation.
 * Returns the payload unchanged when it carries none.
 */
export function regeneratePayload(
  payload: Record<string, unknown>,
  generation: number,
): Record<string, unknown> {
  const out = { ...payload };
  for (const key of ['idempotency_key', 'idempotencyKey']) {
    const value = out[key];
    if (typeof value === 'string' && value) out[key] = freshIdempotencyKey(value, generation);
  }
  return out;
}

