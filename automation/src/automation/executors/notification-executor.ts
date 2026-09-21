import { Injectable } from '@nestjs/common';
import type { ExecutorContext, ExecutorOutcome } from './executor.types';
import { wireCreatedByRule } from './created-by-rule';
import { GrpcActionExecutor } from './grpc-action-executor';
import { buildEmailTemplateContext, renderEmailTemplate, sanitizeHeaderValue } from './email-template';
import { classifyGrpcFailure } from './executor-errors';
import { EffectLedger } from './effect-ledger.service';

const MAX_TITLE_LEN = 200;
const MAX_BODY_LEN = 4000;
const DEFAULT_TITLE = 'Уведомление FairFlow';

/** `channel` values `NotificationGrpc.Send` accepts (anything else = INVALID_ARGUMENT). */
const CHANNELS = new Set(['in_app', 'inapp', 'in-app', 'email', 'all', 'both', 'in_app+email']);

function str(value: unknown): string {
  return typeof value === 'string' ? value : value == null ? '' : String(value);
}

/**
 * Executor of the `send_notification` action (TODO-039), alias `create_notification`.
 *
 * Delivers through the EXISTING notification domain (`NotificationGrpc.Send`),
 * so the in-app feed, the per-user preferences and the single mail relay stay in
 * one place — automation neither writes the notification collection nor opens
 * SMTP itself.
 *
 * Idempotency is NOT free here: `Send` creates a row every time it is called.
 * The executor therefore claims {@link ExecutorContext.effectKey} in the
 * {@link EffectLedger} before dispatching, and releases the claim when the call
 * fails before the notification existed — so a redelivery cannot notify twice,
 * while a genuine retry (fresh generation ⇒ fresh key) still gets through.
 *
 * Recipient resolution never widens: the target user comes from the action
 * config or from the triggering record's assignee, and the notification is
 * always created inside `ctx.projectId`.
 */
@Injectable()
export class NotificationExecutor extends GrpcActionExecutor {
  readonly handles = ['send_notification', 'create_notification'] as const;
  protected readonly grpcUrlEnv = 'NOTIFICATION_GRPC_URL';
  protected readonly grpcPackage = 'fairflow.notification.v1';
  protected readonly grpcServiceName = 'NotificationGrpc';
  protected readonly protoSegments = ['fairflow', 'notification', 'v1', 'notification.proto'];

  constructor(private readonly ledger: EffectLedger) {
    super();
  }

  private timeoutMs(): number {
    const raw = Number(process.env.AUTOMATION_EXECUTOR_TIMEOUT_MS ?? 15000);
    return Number.isFinite(raw) && raw > 0 ? raw : 15000;
  }

  async execute(
    _type: string,
    action: Record<string, unknown>,
    ctx: ExecutorContext,
  ): Promise<ExecutorOutcome> {
    const nested = (
      action.config && typeof action.config === 'object' ? action.config : {}
    ) as Record<string, unknown>;
    const cfg = { ...action, ...nested };

    const configProject = str(cfg.project_id ?? cfg.projectId).trim();
    if (configProject && configProject !== ctx.projectId) {
      return { ok: false, error: 'project_scope_violation' };
    }

    const payload = ctx.payload ?? {};
    const context = { ...buildEmailTemplateContext(payload), trigger: payload };
    const render = (raw: unknown): string => renderEmailTemplate(str(raw), context).text;

    const userId = render(
      cfg.user_id ?? cfg.userId ?? cfg.recipient ?? cfg.assignee_id ?? cfg.assigneeId,
    ).trim()
      || str(payload.assignee_id ?? payload.assigneeId).trim()
      || str(ctx.userId).trim();
    if (!userId) return { ok: false, error: 'send_notification_recipient_required' };

    const title =
      sanitizeHeaderValue(render(cfg.title ?? cfg.subject), MAX_TITLE_LEN) || DEFAULT_TITLE;
    const body = render(cfg.body ?? cfg.message ?? cfg.template ?? cfg.text)
      .trim()
      .slice(0, MAX_BODY_LEN);
    // `Send` rejects an empty body with INVALID_ARGUMENT; catching it here gives
    // the operator the real reason instead of a bare grpc_3.
    if (!body) return { ok: false, error: 'send_notification_body_required' };

    const channel = str(cfg.channel ?? 'in_app').toLowerCase().trim() || 'in_app';
    if (!CHANNELS.has(channel)) {
      return { ok: false, error: `send_notification_unsupported_channel:${channel}` };
    }

    const effectKey = ctx.effectKey ?? '';
    if (!(await this.ledger.claim(ctx.projectId, effectKey))) {
      // Already delivered by the delivery that owns this generation.
      return { ok: true, noop: true };
    }

    const res = await this.invoke(
      'Send',
      {
        project_id: ctx.projectId,
        user_id: userId,
        channel,
        title,
        body,
        data_json: JSON.stringify({
          source: 'automation',
          ...this.linkRefs(payload),
          ...(wireCreatedByRule(ctx) ? { created_by_rule: wireCreatedByRule(ctx) } : {}),
        }),
        email_to: '',
      },
      ctx,
      this.timeoutMs(),
    );
    if (!res.ok) {
      // Nothing was created — hand the key back so the retry can really re-send.
      await this.ledger.release(effectKey);
      return { ok: false, error: classifyGrpcFailure(res, 'send_notification') };
    }
    return { ok: true };
  }

  /** Entity refs carried into `data_json` so the feed item can deep-link. */
  private linkRefs(payload: Record<string, unknown>): Record<string, string> {
    const refs: Record<string, string> = {};
    const put = (key: string, value: unknown): void => {
      const v = str(value).trim();
      if (v) refs[key] = v;
    };
    put('deal_id', payload.deal_id ?? payload.dealId);
    put('contact_id', payload.contact_id ?? payload.contactId);
    put('company_id', payload.company_id ?? payload.companyId);
    put('order_id', payload.order_id ?? payload.orderId);
    put('activity_id', payload.activity_id ?? payload.activityId);
    return refs;
  }
}
