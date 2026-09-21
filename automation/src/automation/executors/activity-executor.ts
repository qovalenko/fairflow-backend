import { Injectable } from '@nestjs/common';
import type { ExecutorContext, ExecutorOutcome } from './executor.types';
import { wireCreatedByRule } from './created-by-rule';
import { GrpcActionExecutor } from './grpc-action-executor';

/**
 * Executes `create_activity` actions by calling `ActivityGrpc.CreateActivity`
 * (contract §1 — ActivityGrpc executor). The activity is created in the rule's
 * project from the service-actor; link refs come from the triggering payload.
 */
@Injectable()
export class ActivityExecutor extends GrpcActionExecutor {
  readonly handles = ['create_activity'] as const;
  protected readonly grpcUrlEnv = 'ACTIVITY_GRPC_URL';
  protected readonly grpcPackage = 'fairflow.activity.v1';
  protected readonly grpcServiceName = 'ActivityGrpc';
  protected readonly protoSegments = ['fairflow', 'activity', 'v1', 'activity.proto'];

  async execute(
    _type: string,
    action: Record<string, unknown>,
    ctx: ExecutorContext,
  ): Promise<ExecutorOutcome> {
    const payload = ctx.payload ?? {};
    // The classic form stores per-action settings under `config` ({type, config:{title}});
    // flat keys are kept for backwards compatibility with hand-written rules.
    const cfg = (action.config && typeof action.config === 'object'
      ? action.config
      : {}) as Record<string, unknown>;
    const req: Record<string, unknown> = {
      project_id: ctx.projectId,
      type: String(action.activity_type ?? cfg.activity_type ?? cfg.type ?? action.type_value ?? 'task'),
      title: String(action.title ?? cfg.title ?? 'Автозадача'),
      description: String(action.description ?? cfg.description ?? ''),
      status: String(action.status ?? cfg.status ?? 'open'),
      priority: String(action.priority_value ?? cfg.priority ?? 'normal'),
      assignee_id: String(
        action.assignee_id ??
          action.assigneeId ??
          cfg.userId ??
          payload.assignee_id ??
          payload.assigneeId ??
          payload.owner_id ??
          payload.ownerId ??
          payload.created_by ??
          payload.createdBy ??
          ctx.ruleAuthorId ??
          ctx.userId ??
          '',
      ),
      deal_id: String(payload.deal_id ?? payload.dealId ?? ''),
      contact_id: String(payload.contact_id ?? payload.contactId ?? ''),
      company_id: String(payload.company_id ?? payload.companyId ?? ''),
      order_id: String(payload.order_id ?? payload.orderId ?? ''),
    };
    const createdByRule = wireCreatedByRule(ctx);
    if (createdByRule) req.created_by_rule = createdByRule;
    const outcome = await this.call('CreateActivity', req, ctx);
    const assignee = String(req.assignee_id ?? '').trim();
    return outcome.ok ? { ok: true, assignee: assignee || undefined } : outcome;
  }
}
