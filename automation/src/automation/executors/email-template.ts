/**
 * Rendering + validation helpers for the `send_email` executor (TODO-039).
 *
 * Deliberately dependency-free and side-effect-free so both the executor and its
 * tests use the exact same code path. Nothing here performs I/O.
 */

/** `{{ path.to.value }}` — dotted lookup only, no expressions, no function calls. */
const PLACEHOLDER = /\{\{\s*([A-Za-z0-9_.-]+)\s*\}\}/g;

/** Keys that must never be walked (prototype pollution / constructor leak). */
const FORBIDDEN_SEGMENTS = new Set(['__proto__', 'prototype', 'constructor']);

/** Control characters (CR/LF included): SMTP header-injection vector. */
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

/**
 * RFC-5321-ish single-mailbox check, intentionally STRICTER than a mail server:
 * one address only, no display name, no angle brackets, no whitespace, no comma
 * or semicolon (so a templated value can never smuggle extra recipients), no
 * control characters (SMTP header injection), IP literals refused.
 *
 * `send_email` is an `externalEffect` action: an address that does not pass this
 * gate is a terminal config error, never a "let's try and see" send.
 */
const ADDRESS =
  /^[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+)*@(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,63}$/;

export const MAX_ADDRESS_LEN = 254;
export const MAX_SUBJECT_LEN = 300;
export const MAX_BODY_LEN = 20_000;

export function isValidEmailAddress(value: string): boolean {
  const v = value.trim();
  if (!v || v.length > MAX_ADDRESS_LEN) return false;
  // eslint-disable-next-line no-control-regex
  if (CONTROL_CHARS.test(v)) return false;
  // Whitespace / list separators / angle brackets: refuse before the shape test
  // so "a@b.ru, c@d.ru" and "Name <a@b.ru>" can never reach the transport.
  if (/[\s,;<>"()[\]\\]/.test(v)) return false;
  const at = v.lastIndexOf('@');
  if (at <= 0 || at === v.length - 1) return false;
  if (at > 64) return false;
  return ADDRESS.test(v);
}

/** Strip control characters (CR/LF header injection) and collapse to one line. */
export function sanitizeHeaderValue(value: string, max: number): string {
  return value
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

/**
 * Build the placeholder context from a dispatch payload.
 *
 * For the order final action the payload is
 * `{ order_id, idempotency_key, assignee_id, snapshot }` (see
 * `FinalActionConsumerService.execute`), so `{{contact.name}}` /
 * `{{company.inn}}` resolve out of the pinned order snapshot and `{{order.id}}`
 * out of the request. Rule-driven sends pass the trigger payload, whose own keys
 * stay addressable at the top level.
 *
 * KNOWN GAP (needs an orders-side change): the order snapshot pinned on the
 * order is `{contact, company}` only (`CONTACT_DRIFT_FIELDS` /
 * `COMPANY_DRIFT_FIELDS` in orders/src/orders/order-drift.ts) and
 * `crm.order.final_action_requested` adds only `orderId`, so the UI's suggested
 * `{{order.number}}` has no source yet. It is left UNSET on purpose rather than
 * defaulted to `''`: an absent key is reported as `unresolved` and warned about,
 * a fabricated empty string would silently look like a resolved value. A
 * snapshot that one day carries `order.*` keeps working — snapshot values are
 * the base, the request-level ids only override what they actually know.
 */
export function buildEmailTemplateContext(
  payload: Record<string, unknown> | undefined,
): Record<string, unknown> {
  const p = payload ?? {};
  const snapshot =
    p.snapshot && typeof p.snapshot === 'object' ? (p.snapshot as Record<string, unknown>) : {};
  const order: Record<string, unknown> =
    snapshot.order && typeof snapshot.order === 'object'
      ? { ...(snapshot.order as Record<string, unknown>) }
      : {};
  const put = (key: string, value: unknown): void => {
    if (value !== undefined && value !== null && value !== '') order[key] = value;
  };
  put('id', p.order_id ?? p.orderId);
  put('number', p.order_number ?? p.orderNumber ?? p.number);
  put('assignee_id', p.assignee_id ?? p.assigneeId);
  return { ...p, ...snapshot, order };
}

function lookup(context: Record<string, unknown>, path: string): unknown {
  let cur: unknown = context;
  for (const segment of path.split('.')) {
    if (!segment || FORBIDDEN_SEGMENTS.has(segment)) return undefined;
    if (cur === null || typeof cur !== 'object') return undefined;
    if (!Object.prototype.hasOwnProperty.call(cur, segment)) return undefined;
    cur = (cur as Record<string, unknown>)[segment];
  }
  return cur;
}

export interface RenderedTemplate {
  text: string;
  /** Placeholders that resolved to nothing — rendered as '' and logged (not fatal). */
  unresolved: string[];
}

/**
 * Substitute `{{path}}` placeholders from `context`. Only scalars interpolate;
 * an unknown path or a non-scalar value renders as an empty string and is
 * reported in `unresolved` so the caller can warn instead of silently mailing a
 * literal `{{order.number}}` to a customer.
 */
export function renderEmailTemplate(
  raw: string,
  context: Record<string, unknown>,
): RenderedTemplate {
  const unresolved: string[] = [];
  const text = raw.replace(PLACEHOLDER, (_match, path: string) => {
    const value = lookup(context, path);
    if (typeof value === 'string') return value;
    if (typeof value === 'number' || typeof value === 'boolean') return String(value);
    unresolved.push(path);
    return '';
  });
  return { text, unresolved };
}
