import { Injectable, Logger } from '@nestjs/common';
import type { ActionExecutor, ExecutorContext, ExecutorOutcome } from './executor.types';
import {
  DomainGrpcClient,
  type GrpcInvokeResult,
} from './grpc-action-executor';
import { buildEmailTemplateContext, renderEmailTemplate } from './email-template';
import { classifyGrpcFailure } from './executor-errors';
import {
  resolveEntityTarget,
  snakeCaseField,
  type EntityDomain,
  type EntityKind,
  type EntityTarget,
  type FieldSpec,
} from './entity-domains';

/** Deadline for one executor→domain call. A wedged peer must not pin a rule run. */
function timeoutMs(): number {
  const raw = Number(process.env.AUTOMATION_EXECUTOR_TIMEOUT_MS ?? 15000);
  return Number.isFinite(raw) && raw > 0 ? raw : 15000;
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : value == null ? '' : String(value);
}

/** Move-path RPC per entity: a stage change is NEVER a plain field write. */
const MOVE_METHOD: Partial<Record<EntityKind, { method: string; idField: string }>> = {
  deal: { method: 'MoveDealToStage', idField: 'deal_id' },
  order: { method: 'MoveOrderToStage', idField: 'order_id' },
};

/** Field aliases the two rule editors (classic form / v2 canvas) actually save. */
const STAGE_KEYS = ['stage_id', 'stageid', 'stage', 'to_stage', 'tostage'];

/**
 * Executor of the three entity-generic CRM actions (TODO-039):
 * `assign_user`, `change_stage` (alias `move_stage`) and `update_field`.
 *
 * Until now all three answered `executor_unavailable`: the rule editor offered
 * them, the rule saved, and at trigger time nothing happened — the exact
 * "UI promises what the backend refuses" defect this wave exists to remove.
 *
 * Design notes that are load-bearing:
 *
 *  - **existing contracts only.** Each action becomes ONE call on the target
 *    domain's existing gRPC service (`PipeGrpc.UpdateDeal`, `ContactGrpc.
 *    UpdateContact`, `OrdersGrpc.MoveOrderToStage`, …). No new REST path, no
 *    cross-domain database access.
 *  - **stage changes go through the move path.** `change_stage` calls
 *    `MoveDealToStage` / `MoveOrderToStage`, never `UpdateDeal{stage_id}` — the
 *    move path is what maintains stageLog/history and emits
 *    `crm.deal.stage_changed`. `update_field` targeting `stage_id` is routed to
 *    the same move path instead of being rejected or written flat.
 *  - **idempotent by read-before-write.** The current record is read first and
 *    the action is a NO-OP when the target value is already in place. So a DLQ
 *    retry, a janitor re-drive of a stuck execution, or a broker redelivery
 *    cannot apply the effect twice (no duplicate stage-log entry, no second
 *    reassignment event).
 *  - **project isolation is not negotiable.** `project_id` always comes from the
 *    dispatch context; a `project_id` in the action config that disagrees is a
 *    terminal `project_scope_violation` — a rule must never reach into another
 *    project. Cross-project entity ids fail on their own, because every target
 *    domain scopes its query by the metadata project.
 *  - **honest error classes.** Bad config (no target, unknown field, empty
 *    value, INVALID_ARGUMENT/NOT_FOUND/PERMISSION_DENIED from the domain) is
 *    TERMINAL; only a live transport fault is marked transient and retried.
 */
@Injectable()
export class CrmEntityExecutor implements ActionExecutor {
  readonly handles = ['assign_user', 'change_stage', 'move_stage', 'update_field'] as const;
  protected readonly logger = new Logger(CrmEntityExecutor.name);
  private readonly clients = new Map<EntityKind, DomainGrpcClient>();

  /** One lazily created client per target domain (see {@link DomainGrpcClient}). */
  protected client(domain: EntityDomain): DomainGrpcClient {
    const existing = this.clients.get(domain.kind);
    if (existing) return existing;
    const created = new DomainGrpcClient(domain.target);
    this.clients.set(domain.kind, created);
    return created;
  }

  protected invoke(
    domain: EntityDomain,
    method: string,
    req: Record<string, unknown>,
    ctx: ExecutorContext,
  ): Promise<GrpcInvokeResult> {
    return this.client(domain).invoke(method, req, ctx, timeoutMs());
  }

  async execute(
    type: string,
    action: Record<string, unknown>,
    ctx: ExecutorContext,
  ): Promise<ExecutorOutcome> {
    // The classic form stores per-action settings nested under `config`; the v2
    // canvas and hand-written rules use flat keys. Accept both, nested wins.
    const nested = (
      action.config && typeof action.config === 'object' ? action.config : {}
    ) as Record<string, unknown>;
    const cfg = { ...action, ...nested };

    // A rule may never target another project: the dispatch context is the only
    // authority for project_id (invariant "x-project-id — нерушимая граница").
    const configProject = str(cfg.project_id ?? cfg.projectId).trim();
    if (configProject && configProject !== ctx.projectId) {
      return { ok: false, error: 'project_scope_violation' };
    }

    const target = resolveEntityTarget(cfg, ctx.payload ?? {}, ctx.entityType);
    if (!target) return { ok: false, error: `${type}_target_unresolved` };

    switch (type) {
      case 'assign_user':
        return this.assignUser(cfg, target, ctx);
      case 'change_stage':
      case 'move_stage':
        return this.changeStage(cfg, target, ctx);
      case 'update_field':
        return this.updateField(cfg, target, ctx);
      default:
        return { ok: false, error: `unsupported_action:${type}` };
    }
  }

  /** `{{...}}` substitution over the trigger payload (same engine as send_email). */
  private render(raw: unknown, ctx: ExecutorContext): string {
    const text = str(raw);
    if (!text.includes('{{')) return text.trim();
    const payload = ctx.payload ?? {};
    const context = { ...buildEmailTemplateContext(payload), trigger: payload };
    return renderEmailTemplate(text, context).text.trim();
  }

  // ── assign_user ─────────────────────────────────────────────────────────
  private async assignUser(
    cfg: Record<string, unknown>,
    target: EntityTarget,
    ctx: ExecutorContext,
  ): Promise<ExecutorOutcome> {
    const userId = this.render(
      cfg.user_id ?? cfg.userId ?? cfg.assignee_id ?? cfg.assigneeId ?? cfg.value,
      ctx,
    );
    if (!userId) return { ok: false, error: 'assign_user_user_required' };
    const field = target.domain.assigneeField;
    const outcome = await this.writeField(target, field, userId, ctx, 'assign_user');
    return outcome.ok ? { ...outcome, assignee: userId } : outcome;
  }

  // ── change_stage / move_stage ───────────────────────────────────────────
  private async changeStage(
    cfg: Record<string, unknown>,
    target: EntityTarget,
    ctx: ExecutorContext,
  ): Promise<ExecutorOutcome> {
    const stageId = this.stageFromConfig(cfg, ctx);
    if (!stageId) return { ok: false, error: 'change_stage_stage_required' };
    return this.moveToStage(target, stageId, ctx);
  }

  private stageFromConfig(cfg: Record<string, unknown>, ctx: ExecutorContext): string {
    for (const key of Object.keys(cfg)) {
      if (!STAGE_KEYS.includes(key.toLowerCase())) continue;
      const value = this.render(cfg[key], ctx);
      if (value) return value;
    }
    return '';
  }

  /**
   * The ONLY way this executor changes a stage. `MoveDealToStage` /
   * `MoveOrderToStage` own stage history, stage_entered_at and the
   * `crm.*.stage_changed` event; writing `stage_id` through the plain update
   * path would leave all three inconsistent.
   */
  private async moveToStage(
    target: EntityTarget,
    stageId: string,
    ctx: ExecutorContext,
  ): Promise<ExecutorOutcome> {
    const move = MOVE_METHOD[target.domain.kind];
    if (!move) return { ok: false, error: `change_stage_unsupported_entity:${target.domain.kind}` };

    // Idempotency: a record already sitting on the requested stage must not get a
    // second stage-log entry / second stage_changed event on a retry.
    const current = await this.readRecord(target, ctx, 'change_stage');
    if ('error' in current) return { ok: false, error: current.error };
    if (str(current.record.stage_id).trim() === stageId) {
      return { ok: true, noop: true };
    }

    const res = await this.invoke(
      target.domain,
      move.method,
      { project_id: ctx.projectId, [move.idField]: target.id, stage_id: stageId },
      ctx,
    );
    if (!res.ok) return { ok: false, error: classifyGrpcFailure(res, 'change_stage') };
    return { ok: true };
  }

  // ── update_field ────────────────────────────────────────────────────────
  private async updateField(
    cfg: Record<string, unknown>,
    target: EntityTarget,
    ctx: ExecutorContext,
  ): Promise<ExecutorOutcome> {
    const rawName = this.render(cfg.field ?? cfg.field_name ?? cfg.fieldName ?? cfg.name, ctx);
    if (!rawName) return { ok: false, error: 'update_field_field_required' };
    const name = snakeCaseField(rawName);
    const value = this.render(cfg.value ?? cfg.field_value ?? cfg.fieldValue, ctx);

    // A stage is not an ordinary field: route it to the move path so history and
    // the stage_changed event stay correct (see moveToStage).
    if (STAGE_KEYS.includes(name)) {
      if (!value) return { ok: false, error: 'change_stage_stage_required' };
      return this.moveToStage(target, value, ctx);
    }

    const spec = target.domain.fields[name];
    if (spec) return this.writeField(target, spec, value, ctx, 'update_field');

    // Order-type custom fields live in the `fields_json` blob.
    if (target.domain.customFieldsJson) return this.writeCustomField(target, name, value, ctx);

    // Unknown field: a config error the operator must see, NOT a silent success
    // and not an endless retry.
    return { ok: false, error: `update_field_unknown_field:${target.domain.kind}.${name}` };
  }

  // ── shared write path ───────────────────────────────────────────────────
  /** Read the record (project-scoped) so the write can be skipped when redundant. */
  private async readRecord(
    target: EntityTarget,
    ctx: ExecutorContext,
    prefix: string,
  ): Promise<{ record: Record<string, unknown> } | { error: string }> {
    const res = await this.invoke(
      target.domain,
      target.domain.getMethod,
      { project_id: ctx.projectId, id: target.id },
      ctx,
    );
    if (!res.ok) return { error: classifyGrpcFailure(res, prefix) };
    return { record: res.response ?? {} };
  }

  private async writeField(
    target: EntityTarget,
    spec: FieldSpec,
    rawValue: string,
    ctx: ExecutorContext,
    prefix: string,
  ): Promise<ExecutorOutcome> {
    const coerced = this.coerce(spec, rawValue);
    if ('error' in coerced) return { ok: false, error: `${prefix}_${coerced.error}` };

    const current = await this.readRecord(target, ctx, prefix);
    if ('error' in current) return { ok: false, error: current.error };
    if (this.alreadyApplied(spec, current.record[spec.read], coerced.value)) {
      return { ok: true, noop: true };
    }

    const res = await this.invoke(
      target.domain,
      target.domain.updateMethod,
      { project_id: ctx.projectId, id: target.id, [spec.write]: coerced.value },
      ctx,
    );
    if (!res.ok) return { ok: false, error: classifyGrpcFailure(res, prefix) };
    return { ok: true };
  }

  /**
   * Order-type custom field: `UpdateOrder` REPLACES `fields_json`, so the current
   * blob is read, the one key merged in, and the whole blob sent back. Skipping
   * the read would wipe every other field of the sale.
   */
  private async writeCustomField(
    target: EntityTarget,
    name: string,
    value: string,
    ctx: ExecutorContext,
  ): Promise<ExecutorOutcome> {
    const blobSpec = target.domain.customFieldsJson;
    if (!blobSpec) return { ok: false, error: `update_field_unknown_field:${name}` };
    const current = await this.readRecord(target, ctx, 'update_field');
    if ('error' in current) return { ok: false, error: current.error };

    let fields: Record<string, unknown> = {};
    try {
      const parsed: unknown = JSON.parse(str(current.record[blobSpec.read]) || '{}');
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        fields = parsed as Record<string, unknown>;
      }
    } catch {
      // Corrupt blob on the record: refuse rather than overwrite the sale's data.
      return { ok: false, error: 'update_field_fields_json_unreadable' };
    }
    if (str(fields[name]) === value) return { ok: true, noop: true };

    const res = await this.invoke(
      target.domain,
      target.domain.updateMethod,
      {
        project_id: ctx.projectId,
        id: target.id,
        [blobSpec.write]: JSON.stringify({ ...fields, [name]: value }),
      },
      ctx,
    );
    if (!res.ok) return { ok: false, error: classifyGrpcFailure(res, 'update_field') };
    return { ok: true };
  }

  private coerce(
    spec: FieldSpec,
    raw: string,
  ): { value: string | number | string[] } | { error: string } {
    if (spec.kind === 'number') {
      const num = Number(raw);
      if (!raw.trim() || !Number.isFinite(num)) return { error: 'value_not_a_number' };
      return { value: num };
    }
    if (spec.kind === 'string_list') {
      return {
        value: raw
          .split(',')
          .map((v) => v.trim())
          .filter(Boolean),
      };
    }
    // proto3 does not serialize an empty string, so "clear this field" cannot be
    // expressed over the wire — refuse instead of sending a silent no-op write.
    if (!raw.trim()) return { error: 'value_required' };
    return { value: raw };
  }

  /** True when the record already carries the requested value (retry-safe no-op). */
  private alreadyApplied(spec: FieldSpec, current: unknown, next: string | number | string[]): boolean {
    if (spec.kind === 'number') return Number(current ?? NaN) === Number(next);
    if (spec.kind === 'string_list') {
      const cur = Array.isArray(current) ? current.map(str) : [];
      const nxt = Array.isArray(next) ? next.map(str) : [];
      return cur.length === nxt.length && [...cur].sort().join(' ') === [...nxt].sort().join(' ');
    }
    // A repeated read field paired with a scalar write (contact.company_ids ←
    // company_id): already applied iff the list is exactly that one member.
    if (Array.isArray(current)) return current.length === 1 && str(current[0]) === str(next);
    return str(current) === str(next);
  }
}
