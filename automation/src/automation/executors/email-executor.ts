import { Injectable } from '@nestjs/common';
import type { ExecutorContext, ExecutorOutcome } from './executor.types';
import { GrpcActionExecutor, type GrpcInvokeResult } from './grpc-action-executor';
import {
  MAX_BODY_LEN,
  MAX_SUBJECT_LEN,
  buildEmailTemplateContext,
  isValidEmailAddress,
  renderEmailTemplate,
  sanitizeHeaderValue,
} from './email-template';

/**
 * Error-code prefix the callers treat as TRANSIENT (worth another delivery on
 * the bounded retry ladder). Everything else this executor returns is terminal
 * by construction — see the class doc. Imported by
 * `FinalActionConsumerService.isTransient`, so the two never drift apart.
 */
export const EMAIL_TRANSIENT_ERROR = 'email_send_unavailable';

/** Fallback subject when the order type / rule left it empty. */
const DEFAULT_SUBJECT = 'Уведомление FairFlow';

/**
 * gRPC statuses that mean "asking again will not help" (terminal), mapped to the
 * operator-facing code that lands in `order.lastError`. The two deployment
 * faults get a self-explanatory code of their own — `grpc_16` in a sales manager's
 * error banner is a support ticket, `email_transport_unauthorized` is a fix.
 */
const TERMINAL_GRPC_CODES = new Map<number, string>([
  [3, 'email_send_rejected:grpc_3'], //  INVALID_ARGUMENT
  [5, 'email_send_rejected:grpc_5'], //  NOT_FOUND
  [7, 'email_send_rejected:grpc_7'], //  PERMISSION_DENIED
  [9, 'email_send_rejected:grpc_9'], //  FAILED_PRECONDITION
  // UNIMPLEMENTED — notification build without SendTransactionalEmail.
  [12, 'email_transport_unimplemented'],
  // UNAUTHENTICATED — AUTOMATION_SERVICE_API_KEY is unset/inactive in auth, so
  // notification's inbound key guard refuses the call (see needs_owner: the key
  // is not provisioned in the cluster secret yet).
  [16, 'email_transport_unauthorized'],
]);

/** Permanent SMTP rejections (5xx / enhanced 5.x.y / nodemailer envelope errors). */
const PERMANENT_SMTP =
  /\b5\d{2}[\s-]|\b5\.\d\.\d\b|EENVELOPE|No recipients defined|Invalid recipient|Recipient address rejected|Mailbox unavailable|User unknown/i;

/**
 * X1 — addresses embedded in free-form transport text. The executor never
 * interpolates the recipient itself, but nodemailer/SMTP echo the envelope into
 * the message ("550 5.1.1 <john.doe@example.com>: Recipient address rejected"),
 * and that message is copied verbatim into `order.lastError` — persistent order
 * state rendered in the UI to whoever can open the order. notification masks at
 * the source; this is the second line of defence, because `res.error` can also
 * come from the gRPC layer (a DNS/envelope error surfacing as a client-side
 * exception) and never passes through notification's masking at all.
 */
const EMAIL_IN_TEXT = /[A-Za-z0-9!#$%&'*+/=?^_`{|}~.-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/g;

/**
 * `local@domain` → `l***@domain`: the domain half (relay/typo diagnosis) survives,
 * the mailbox does not. A one-character local part is dropped whole — `a***@x.tld`
 * would BE the address.
 */
function maskAddress(addr: string): string {
  const at = addr.lastIndexOf('@');
  if (at <= 0 || at === addr.length - 1) return '***';
  const local = addr.slice(0, at);
  const domain = addr.slice(at + 1);
  return local.length > 1 ? `${local[0]}***@${domain}` : `***@${domain}`;
}

/** Mask every address inside a transport message, keeping the rest verbatim. */
export function maskEmailsInDetail(detail: string): string {
  return detail.replace(EMAIL_IN_TEXT, (m) => maskAddress(m));
}

/**
 * Trim a transport message down to something safe for `order.lastError`: masked
 * (X1 — no client mailbox in persistent order state) and length-bounded, but NOT
 * emptied — the SMTP code/wording is the whole diagnostic value of the field.
 */
function short(detail: string): string {
  const one = sanitizeHeaderValue(maskEmailsInDetail(detail), 200);
  return one ? `:${one}` : '';
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : value == null ? '' : String(value);
}

/**
 * Executor of the `send_email` action (TODO-039, FR-ORDERS-270 email branch).
 *
 * Sends through the EXISTING notification domain
 * (`NotificationGrpc.SendTransactionalEmail`) — automation never opens an SMTP
 * connection of its own, so the single outbound relay, its identity and its
 * fail-safe (`MAIL_ENABLED`) stay in one place. Guarantees:
 *
 *  - **honest classification**: `SendTransactionalEmail` answers with a body
 *    (`status: sent|failed|skipped`), not an exception, so a successful RPC with
 *    `status:'failed'` is reported as a FAILURE, never a false success;
 *  - **terminal vs transient**: config problems (missing/invalid recipient,
 *    mailer disabled, permanent SMTP rejection, UNAUTHENTICATED/UNIMPLEMENTED)
 *    fail terminally with a stable code; only a live transport fault
 *    (UNAVAILABLE, deadline, 4xx-less network error) returns
 *    {@link EMAIL_TRANSIENT_ERROR} and climbs the caller's retry ladder;
 *  - **no header injection**: the recipient is validated as ONE mailbox after
 *    template rendering (no comma/semicolon/angle brackets/control chars) and
 *    the subject is stripped of control characters;
 *  - **idempotency stays with the caller**: the final-action saga claims the
 *    `payloadGen:sendGen` key BEFORE dispatching, so a broker redelivery of the
 *    same send never reaches this executor twice; a user-initiated resend gets a
 *    fresh generation and is meant to send again.
 *
 * At-least-once caveat: a deadline/UNAVAILABLE after the relay already accepted
 * the message can produce a duplicate on the next ladder step. Non-delivery is
 * the worse failure for a closing sale, so the transient path is kept.
 */
@Injectable()
export class EmailExecutor extends GrpcActionExecutor {
  readonly handles = ['send_email'] as const;
  protected readonly grpcUrlEnv = 'NOTIFICATION_GRPC_URL';
  protected readonly grpcPackage = 'fairflow.notification.v1';
  protected readonly grpcServiceName = 'NotificationGrpc';
  protected readonly protoSegments = ['fairflow', 'notification', 'v1', 'notification.proto'];

  private timeoutMs(): number {
    const raw = Number(process.env.AUTOMATION_EMAIL_TIMEOUT_MS ?? 30000);
    return Number.isFinite(raw) && raw > 0 ? raw : 30000;
  }

  async execute(
    _type: string,
    action: Record<string, unknown>,
    ctx: ExecutorContext,
  ): Promise<ExecutorOutcome> {
    // The order-type form stores the config nested (`{type:'email', config:{…}}`)
    // and `final-action.consumer.mapAction` forwards it as `{config}`; hand-written
    // rule actions keep flat keys. Accept both, nested wins.
    const nested = (
      action.config && typeof action.config === 'object' ? action.config : {}
    ) as Record<string, unknown>;
    const cfg = { ...action, ...nested };

    const context = buildEmailTemplateContext(ctx.payload);

    const to = renderEmailTemplate(str(cfg.to ?? cfg.email ?? cfg.recipient), context).text.trim();
    if (!to) return { ok: false, error: 'email_recipient_required' };
    if (!isValidEmailAddress(to)) {
      // Address is NOT echoed back: it lands in order.lastError / logs (PII).
      return { ok: false, error: 'email_recipient_invalid' };
    }

    const subjectRendered = renderEmailTemplate(str(cfg.subject ?? cfg.title), context);
    const subject =
      sanitizeHeaderValue(subjectRendered.text, MAX_SUBJECT_LEN) || DEFAULT_SUBJECT;

    const bodyRendered = renderEmailTemplate(
      str(cfg.template ?? cfg.body ?? cfg.text),
      context,
    );
    const body = bodyRendered.text.trim().slice(0, MAX_BODY_LEN) || this.defaultBody(context);

    const unresolved = [...new Set([...subjectRendered.unresolved, ...bodyRendered.unresolved])];
    if (unresolved.length > 0) {
      // Not fatal: an empty substitution is better than mailing a literal
      // `{{order.number}}`, but the operator must be able to see the gap.
      this.logger.warn(
        `send_email: unresolved placeholders [${unresolved.join(', ')}] (project=${ctx.projectId})`,
      );
    }

    const res = await this.invoke(
      'SendTransactionalEmail',
      {
        to,
        // Copy kind for machine-sent mail: no CTA button, "do not reply" footer.
        kind: 'automation',
        action_url: '',
        user_name: '',
        subject,
        // Title (H1) = subject, otherwise every automation mail is headed "FairFlow".
        title: subject,
        body,
      },
      ctx,
      this.timeoutMs(),
    );

    return this.interpret(res);
  }

  /** Turn the RPC/response pair into a terminal or transient executor outcome. */
  private interpret(res: GrpcInvokeResult): ExecutorOutcome {
    if (!res.ok) {
      if (res.notConfigured) {
        // NOTIFICATION_GRPC_URL is unset: a deployment config error, not a blip.
        return { ok: false, error: 'email_transport_not_configured' };
      }
      const terminal = res.grpcCode != null ? TERMINAL_GRPC_CODES.get(res.grpcCode) : undefined;
      if (terminal) return { ok: false, error: terminal };
      return { ok: false, error: `${EMAIL_TRANSIENT_ERROR}${short(str(res.error))}` };
    }

    const body = res.response ?? {};
    const status = str(body.status).toLowerCase();
    const detail = str(body.error);
    if (status === 'sent') return { ok: true };
    if (status === 'skipped') {
      // notification refused to send at all: mailer disabled / empty recipient.
      return {
        ok: false,
        error: detail.includes('mailer_disabled')
          ? 'email_transport_disabled'
          : // X1: `short` masks + bounds; `no_recipient`-style codes pass through
            // unchanged, an echoed envelope address does not.
            `email_not_sent${short(detail) || ':skipped'}`,
      };
    }
    if (status === 'failed') {
      return {
        ok: false,
        error: PERMANENT_SMTP.test(detail)
          ? `email_rejected${short(detail)}`
          : `${EMAIL_TRANSIENT_ERROR}${short(detail)}`,
      };
    }
    // Unknown/empty status — treat as a transport-level unknown (retryable).
    return { ok: false, error: `${EMAIL_TRANSIENT_ERROR}:unexpected_status_${status || 'empty'}` };
  }

  /**
   * Body used when the order type has no template. The order-type form does not
   * require one, so an empty template must still produce a sensible letter
   * instead of a terminal error (that would be the very "UI promises what the
   * backend refuses" defect this executor exists to remove).
   */
  private defaultBody(context: Record<string, unknown>): string {
    const order = (context.order ?? {}) as Record<string, unknown>;
    const ref = str(order.number) || str(order.id);
    return ref
      ? `Продажа ${ref} завершена. Письмо отправлено автоматически.`
      : 'Событие в FairFlow. Письмо отправлено автоматически.';
  }
}
