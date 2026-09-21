import { Injectable, Logger } from '@nestjs/common';
import { ObjectId } from 'mongodb';
import { assertResolvedTargetAllowed, newEntityId, validateWebhookTarget } from '@fairflow/shared';
import { MongoService } from '../mongo/mongo.service';
import { RabbitMqService } from '../messaging/rabbitmq.service';
import { emitAutomationEvent } from './event-emitter';
import { ExecutorRegistry } from './executors/executor-registry.service';
import type { RunActor } from './executors/executor.types';
import { isTransientExecutorError } from './executors/executor-errors';
import { attemptCapFor, backoffMs, isRetryableFailure } from './dlq-retry.policy';
import { EXTERNAL_EFFECT_ACTIONS } from './registry';
import { createHmac } from 'node:crypto';
import { SecretProviderRegistry } from './secret-provider';
import { OperatorNotifyService } from './operator-notify.service';

/** One action's terminal outcome inside an execution (contract §3.10 actionResults). */
export type ActionStatus = 'success' | 'skipped' | 'fail' | 'deferred';

export interface ActionResult {
  index: number;
  type: string;
  status: ActionStatus;
  error?: string;
  attempts: number;
  assignee?: string;
  connection_id?: string;
  dlq_id?: string;
  http_code?: number;
}

/** Aggregate execution status derived from the per-action outcomes. */
export type ExecutionOutcome = 'success' | 'partial_fail' | 'fail' | 'skipped';

export interface DispatchResult {
  status: ExecutionOutcome;
  action_results: ActionResult[];
}

interface DispatchContext {
  projectId: string;
  ruleId: string;
  /** Denormalized rule title for `created_by_rule` on domain mutations (FR-MAUT-36). */
  ruleName?: string;
  executionId: string;
  source: string;
  payload: Record<string, unknown>;
  /**
   * Whose visibility this dispatch runs under — see {@link RunActor}. Every
   * gateway-facing entry point is `user`; only the bus/janitor/final-action
   * paths declare `system`. Absent ⇒ `user` (fail-closed).
   */
  actor?: RunActor;
  /** caller user id (for visibility-scoped actor), '' for the service-bus path. */
  userId?: string;
  /** Rule author — attribution/fallback assignee, not visibility scope (FR-AUTOM-100/110). */
  ruleAuthorId?: string;
  /**
   * Serialized `x-visibility-scope` of the originating caller, forwarded to the
   * executor domains for a USER-initiated run so a rule execution cannot reach
   * records the caller may not see (§3.8). Absent on the system path.
   */
  visibilityScope?: string;
  /** Entity type of the rule's trigger (`deal`, `contact`, …) — see ExecutorContext. */
  entityType?: string;
  /**
   * Retry generation of THIS dispatch (0 = first delivery). Feeds the effect key
   * so a genuine retry is a NEW effect rather than a swallowed duplicate — the
   * `payloadGen:sendGen` discipline (see `DlqRetryService.freshIdempotencyKey`).
   */
  retryGeneration?: number;
  /**
   * Position of the action inside its rule, for a SINGLE-action re-dispatch
   * ({@link ActionDispatcher.dispatchOne}). The index is part of both the effect
   * key and the outbound delivery id, so a DLQ retry of action #2 must present
   * itself as action #2 — replaying it as #0 (the old behaviour) minted a
   * different identity for the same delivery and defeated receiver-side dedup.
   */
  actionIndex?: number;
  dryRun?: boolean;
  /**
   * Suppress DLQ writes for this dispatch (DLQ retry path §3.19): the retry
   * updates the EXISTING row with the outcome instead of minting a duplicate.
   */
  skipDlq?: boolean;
}

type ConnectionDoc = {
  id: string;
  project_id: string;
  url: string;
  headers_json?: string;
  /** Opaque secret reference (`<scheme>:...`); selects the reveal provider (P2.d). */
  secret_ref?: string;
  /** AES-256-GCM envelope of the connection secret (audit #24.1); decrypted at send time. */
  secret_enc?: string;
  enabled: boolean;
  breaker_state?: string;
  breaker_failures?: number;
  breaker_opened_at?: number;
  created_by?: string;
};

const BREAKER_OPEN_THRESHOLD = Number(process.env.AUTOMATION_BREAKER_THRESHOLD ?? 5) || 5;
const BREAKER_COOLDOWN_MS = Number(process.env.AUTOMATION_BREAKER_COOLDOWN_MS ?? 300_000) || 300_000;
const WEBHOOK_TIMEOUT_MS = Number(process.env.AUTOMATION_WEBHOOK_TIMEOUT_MS ?? 8000) || 8000;

async function emitActionFailed(
  rabbit: RabbitMqService,
  ctx: DispatchContext,
  index: number,
  type: string,
  extra?: Record<string, unknown>,
): Promise<void> {
  await emitAutomationEvent(rabbit, {
    type: 'automation.action.failed',
    projectId: ctx.projectId,
    subject: `rule/${ctx.ruleId}`,
    payload: {
      rule_id: ctx.ruleId,
      execution_id: ctx.executionId,
      action_index: index,
      action_type: type,
      ...extra,
    },
  });
}

/**
 * Real action dispatcher (contract §3.7/§5, FR-MAUT-8/8a, SEC-2/3).
 *
 * Executes a rule's ordered `actions[]` against the executor domains (CRM
 * mutations via gRPC executor clients) and outbound connections (`send_webhook`)
 * from the service-actor. Invariants enforced here:
 *  - **isolation**: every action carries the rule's `project_id`; connections are
 *    resolved scoped `{project_id}` and the endpoint is taken from the connection
 *    record, NEVER from a client-supplied payload (anti-SSRF allowlist, §3.7);
 *  - **anti-SSRF / TOCTOU**: the connection URL is re-validated AND re-resolved at
 *    send time (DNS-rebinding guard) before the request leaves the process;
 *  - **circuit-breaker**: a connection with an open breaker is short-circuited to
 *    a deferred/DLQ outcome instead of hammering a failing endpoint;
 *  - **failure → DLQ**: a failed external/irreversible action lands in
 *    `automation_dlq` (project-scoped) and emits `automation.action.failed`,
 *    instead of being silently dropped — manual retry is exactly-once (§3.19);
 *  - **dry-run safety**: when `dryRun` is set NO external effect is produced
 *    (no gRPC, no HTTP, no DLQ) — §3.9 security invariant.
 */
@Injectable()
export class ActionDispatcher {
  private readonly logger = new Logger(ActionDispatcher.name);

  constructor(
    private readonly mongo: MongoService,
    private readonly rabbit: RabbitMqService,
    private readonly executors: ExecutorRegistry,
    private readonly secrets: SecretProviderRegistry,
    private readonly operatorNotify: OperatorNotifyService,
  ) {}

  /**
   * Execute the ordered action list of a rule. `actionsJson` is the rule's
   * stored `actions_json` (array of `{ type, ... }`, optionally with `priority`).
   */
  async dispatch(actionsJson: string, ctx: DispatchContext): Promise<DispatchResult> {
    const actions = this.parseActions(actionsJson);
    const results: ActionResult[] = [];
    for (let i = 0; i < actions.length; i++) {
      const action = actions[i];
      const type = String(action.type ?? action.id ?? '').trim();
      if (!type) {
        results.push({ index: i, type: '', status: 'skipped', attempts: 0, error: 'missing_type' });
        continue;
      }
      results.push(await this.runAction(i, type, action, ctx));
    }
    return { status: this.aggregate(results), action_results: results };
  }

  /**
   * Re-dispatch a SINGLE action (DLQ retry, §3.19/FR-AUTOM-175). Runs the exact
   * same pipeline as `dispatch` for one action — including the send-time
   * deny-list + DNS re-validation for webhooks — with the caller controlling
   * DLQ suppression via `ctx.skipDlq`.
   */
  async dispatchOne(
    type: string,
    action: Record<string, unknown>,
    ctx: DispatchContext,
  ): Promise<ActionResult> {
    const index = Number(ctx.actionIndex ?? 0);
    return this.runAction(Number.isFinite(index) && index > 0 ? Math.trunc(index) : 0, type, action, ctx);
  }

  /** Ordered (by `priority` asc, then declared order) action list. */
  private parseActions(raw: string): Array<Record<string, unknown>> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw || '[]');
    } catch {
      return [];
    }
    if (!Array.isArray(parsed)) return [];
    const list = parsed.filter((a): a is Record<string, unknown> => !!a && typeof a === 'object');
    return list
      .map((a, declared) => ({ a, declared, priority: Number(a.priority ?? 100) }))
      .sort((x, y) => x.priority - y.priority || x.declared - y.declared)
      .map((e) => e.a);
  }

  private async runAction(
    index: number,
    type: string,
    action: Record<string, unknown>,
    ctx: DispatchContext,
  ): Promise<ActionResult> {
    // Dry-run: never produce an external effect — report would-run only.
    if (ctx.dryRun) {
      return { index, type, status: 'skipped', attempts: 0, error: 'dry_run' };
    }
    try {
      if (EXTERNAL_EFFECT_ACTIONS.has(type) && type === 'send_webhook') {
        return await this.runWebhook(index, type, action, ctx);
      }
      // CRM / domain mutations dispatched via the executor registry (gRPC).
      return await this.runDomainAction(index, type, action, ctx);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn(`Action ${type}#${index} failed for rule ${ctx.ruleId}: ${message}`);
      const dlqId = EXTERNAL_EFFECT_ACTIONS.has(type)
        ? await this.toDlq(index, type, action, ctx, message)
        : undefined;
      return { index, type, status: 'fail', attempts: 1, error: message, dlq_id: dlqId };
    }
  }

  /** Dispatch a CRM action to an executor domain (or DLQ when unavailable). */
  private async runDomainAction(
    index: number,
    type: string,
    action: Record<string, unknown>,
    ctx: DispatchContext,
  ): Promise<ActionResult> {
    const executor = this.executors.forAction(type);
    if (!executor) {
      // No executor wired for this action type yet — record as deferred (not a
      // false success). External-effect kinds also land in DLQ for visibility
      // (+ automation.action.failed) so e.g. a send_email never vanishes silently.
      if (EXTERNAL_EFFECT_ACTIONS.has(type)) {
        const dlqId = await this.toDlq(index, type, action, ctx, 'executor_unavailable');
        await emitActionFailed(this.rabbit, ctx, index, type);
        return { index, type, status: 'deferred', attempts: 0, error: 'executor_unavailable', dlq_id: dlqId };
      }
      return { index, type, status: 'deferred', attempts: 0, error: 'executor_unavailable' };
    }
    const outcome = await executor.execute(type, action, {
      projectId: ctx.projectId,
      actor: ctx.actor ?? 'user',
      userId: ctx.userId,
      payload: ctx.payload,
      visibilityScope: ctx.visibilityScope,
      entityType: ctx.entityType,
      effectKey: this.effectKey(index, type, ctx),
      ruleId: ctx.ruleId,
      ruleName: ctx.ruleName,
      ruleAuthorId: ctx.ruleAuthorId,
    });
    // A FAILED action must stay visible (§3.7 "failure → DLQ") — and, since
    // TODO-041, retryable: the DLQ row is what the auto-retry sweeper polls.
    // External-effect kinds always land there (that guarantee predates this);
    // a plain CRM action joins them only when its failure was TRANSIENT, so a
    // misconfigured rule is reported once instead of looping on the ladder.
    // `skipDlq` (the order final-action path, which journals on the order
    // itself, and the retry path itself) is honoured inside `toDlq`.
    if (!outcome.ok) {
      const error = outcome.error ?? 'action_failed';
      const external = EXTERNAL_EFFECT_ACTIONS.has(type);
      const dlqId =
        external || isTransientExecutorError(error)
          ? await this.toDlq(index, type, action, ctx, error)
          : undefined;
      if (external && !ctx.skipDlq) {
        await emitActionFailed(this.rabbit, ctx, index, type);
      }
      return { index, type, status: 'fail', attempts: 1, error, dlq_id: dlqId };
    }
    return {
      index,
      type,
      status: 'success',
      attempts: 1,
      assignee: outcome.assignee,
    };
  }

  /**
   * Stable key of one effect attempt, handed to executors whose target cannot
   * dedup on its own (`send_notification` → {@link EffectLedger}).
   *
   * The retry generation is part of the key ON PURPOSE: a redelivery of the same
   * attempt must be swallowed, while an operator-requested retry must actually
   * reach the user. Reusing the key across retries is precisely the bug that let
   * a "retried" action silently do nothing.
   */
  private effectKey(index: number, type: string, ctx: DispatchContext): string {
    const gen = Number(ctx.retryGeneration ?? 0) || 0;
    return `${ctx.projectId}:${ctx.executionId}:${index}:${type}:${gen}`;
  }

  /** Outbound webhook from the approved connection allowlist (anti-SSRF, breaker). */
  private async runWebhook(
    index: number,
    type: string,
    action: Record<string, unknown>,
    ctx: DispatchContext,
  ): Promise<ActionResult> {
    const connectionId = String(action.connection_id ?? action.connectionId ?? '').trim();
    if (!connectionId) {
      // Endpoint MUST come from a connection, never from the payload (§3.7).
      const dlqId = await this.toDlq(index, type, action, ctx, 'connection_id is required');
      return { index, type, status: 'fail', attempts: 0, error: 'connection_id_required', dlq_id: dlqId };
    }
    let conn = (await this.mongo
      .connections()
      .findOne({ project_id: ctx.projectId, id: connectionId })) as unknown as ConnectionDoc | null;
    if (!conn || !conn.enabled) {
      const dlqId = await this.toDlq(index, type, action, ctx, 'connection_not_found_or_disabled', connectionId);
      return { index, type, status: 'fail', attempts: 0, connection_id: connectionId, error: 'connection_unavailable', dlq_id: dlqId };
    }
    conn = await this.ensureBreakerAllows(conn);
    // Circuit-breaker: open (cooldown not elapsed) short-circuits to deferred/DLQ.
    if (conn.breaker_state === 'open') {
      const dlqId = await this.toDlq(index, type, action, ctx, 'breaker_open', connectionId);
      return { index, type, status: 'deferred', attempts: 0, connection_id: connectionId, error: 'breaker_open', dlq_id: dlqId };
    }
    // Re-validate the endpoint against the deny-list (static) + DNS re-resolve
    // (TOCTOU / rebinding) at SEND time — a later-poisoned URL must not "revive".
    if (!validateWebhookTarget(conn.url).ok) {
      const dlqId = await this.toDlq(index, type, action, ctx, 'webhook_target_invalid', connectionId);
      return { index, type, status: 'fail', attempts: 0, connection_id: connectionId, error: 'webhook_target_invalid', dlq_id: dlqId };
    }
    const resolved = await assertResolvedTargetAllowed(conn.url);
    if (!resolved.ok) {
      const dlqId = await this.toDlq(index, type, action, ctx, `webhook_target_resolved_${resolved.reason}`, connectionId);
      return { index, type, status: 'fail', attempts: 0, connection_id: connectionId, error: 'webhook_target_invalid', dlq_id: dlqId };
    }

    const { ok, httpCode, error } = await this.sendWebhook(conn, ctx, index);
    await this.updateBreaker(conn, ok);
    if (ok) {
      return { index, type, status: 'success', attempts: 1, connection_id: connectionId, http_code: httpCode };
    }
    const dlqId = await this.toDlq(index, type, action, ctx, error ?? `http_${httpCode}`, connectionId, httpCode);
    await emitActionFailed(this.rabbit, ctx, index, type);
    return { index, type, status: 'fail', attempts: 1, connection_id: connectionId, http_code: httpCode, error, dlq_id: dlqId };
  }

  /**
   * Identity of ONE outbound delivery, stable across every re-send of it.
   *
   * Deliberately free of the retry generation: the whole point is that attempt 1
   * and its DLQ re-sends carry the SAME id, so a receiver can recognise "I have
   * already processed this" — see {@link sendWebhook}. The generation travels
   * next to it as `attempt`.
   */
  private deliveryId(index: number, ctx: DispatchContext): string {
    return `${ctx.projectId}:${ctx.executionId}:${index}`;
  }

  /** Perform the HTTP POST. Secrets are NEVER logged. */
  private async sendWebhook(
    conn: ConnectionDoc,
    ctx: DispatchContext,
    index: number,
  ): Promise<{ ok: boolean; httpCode?: number; error?: string }> {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    try {
      const parsed = JSON.parse(conn.headers_json || '{}');
      if (parsed && typeof parsed === 'object') {
        for (const [k, v] of Object.entries(parsed)) headers[k] = String(v);
      }
    } catch {
      // Malformed stored headers → ignore, send with defaults.
    }
    // Delivery semantics are AT-LEAST-ONCE and always were (the bus redelivers,
    // the DLQ ladder re-sends, a lease expiry re-drives) — but the body used to
    // carry nothing that let the receiver tell a re-send from a new event, so a
    // slow-but-successful endpoint got the same order/deal N times with no way
    // to notice. `deliveryId` is the dedup key (stable across retries),
    // `attempt` is the generation (0 = first delivery). Both are in the SIGNED
    // body and mirrored into headers for receivers that dedup at the edge; the
    // header copies are set after the connection's own headers so a stored
    // header can never shadow them.
    const deliveryId = this.deliveryId(index, ctx);
    const attempt = Number(ctx.retryGeneration ?? 0) || 0;
    headers['x-fairflow-delivery-id'] = deliveryId;
    headers['x-fairflow-attempt'] = String(attempt);
    const body = JSON.stringify({
      projectId: ctx.projectId,
      ruleId: ctx.ruleId,
      deliveryId,
      attempt,
      payload: ctx.payload,
    });
    // Sign the body with the (decrypted, audit #24.1) connection secret so the
    // receiver can verify authenticity. When a secret IS configured but cannot be
    // decrypted, fail-closed — never send an unsigned body (FR-AUTOM-180).
    const hasStoredSecret = Boolean(
      String(conn.secret_ref ?? '').trim() || String(conn.secret_enc ?? '').trim(),
    );
    const secret = await this.decryptConnectionSecret(conn);
    if (hasStoredSecret && !secret) {
      return { ok: false, error: 'secret_decrypt_failed' };
    }
    if (secret) {
      headers['x-fairflow-signature'] = `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), WEBHOOK_TIMEOUT_MS);
    try {
      const res = await fetch(conn.url, {
        method: 'POST',
        headers,
        body,
        // Do NOT follow redirects: a 30x to a private/metadata IP would bypass
        // the anti-SSRF deny-list checked against the original connection URL.
        redirect: 'error',
        signal: controller.signal,
      });
      if (res.ok) return { ok: true, httpCode: res.status };
      return { ok: false, httpCode: res.status, error: `http_${res.status}` };
    } catch (err) {
      const message = err instanceof Error ? err.name === 'AbortError' ? 'timeout' : err.message : String(err);
      return { ok: false, error: message };
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Decrypt a connection's at-rest secret (audit #24.1) for send-time signing.
   * Returns '' when there is no secret, when the key is unavailable, or when the
   * envelope fails to authenticate — never throws and never logs the plaintext.
   */
  private async decryptConnectionSecret(conn: ConnectionDoc): Promise<string> {
    try {
      // Provider is selected by the connection's secret_ref scheme (P2.d). The
      // local provider decrypts the AES envelope; an unknown/unconfigured scheme
      // throws here and is caught below (no signature rather than exposure).
      return await this.secrets.reveal({ secret_ref: conn.secret_ref, secret_enc: conn.secret_enc });
    } catch (err) {
      this.logger.warn(
        `Connection ${conn.id} secret could not be decrypted: ${err instanceof Error ? err.name : 'error'}`,
      );
      return '';
    }
  }

  /** Open → half_open after cooldown; half_open allows a single probe (FR-AUTOM-190). */
  private async ensureBreakerAllows(conn: ConnectionDoc): Promise<ConnectionDoc> {
    const state = conn.breaker_state ?? 'closed';
    if (state !== 'open') return conn;
    const now = Date.now();
    const openedAt = conn.breaker_opened_at ?? 0;
    if (now - openedAt < BREAKER_COOLDOWN_MS) return conn;
    await this.mongo.connections().updateOne(
      { project_id: conn.project_id, id: conn.id },
      { $set: { breaker_state: 'half_open', updated_at: now } },
    );
    return { ...conn, breaker_state: 'half_open' };
  }

  /** Trip / reset the connection circuit-breaker (§5.4, breaker_opened event). */
  private async updateBreaker(conn: ConnectionDoc, ok: boolean): Promise<void> {
    const now = Date.now();
    if (ok) {
      await this.mongo.connections().updateOne(
        { project_id: conn.project_id, id: conn.id },
        { $set: { breaker_state: 'closed', breaker_failures: 0, updated_at: now } },
      );
      return;
    }
    const fromHalfOpen = (conn.breaker_state ?? 'closed') === 'half_open';
    const failures = fromHalfOpen
      ? BREAKER_OPEN_THRESHOLD
      : (conn.breaker_failures ?? 0) + 1;
    const open = fromHalfOpen || failures >= BREAKER_OPEN_THRESHOLD;
    await this.mongo.connections().updateOne(
      { project_id: conn.project_id, id: conn.id },
      {
        $set: {
          breaker_failures: failures,
          breaker_state: open ? 'open' : conn.breaker_state ?? 'closed',
          ...(open ? { breaker_opened_at: now } : {}),
          updated_at: now,
        },
      },
    );
    if (open) {
      await emitAutomationEvent(this.rabbit, {
        type: 'automation.connection.breaker_opened',
        projectId: conn.project_id,
        subject: `connection/${conn.id}`,
        payload: {
          connection_id: conn.id,
          failures,
        },
      });
      const notifyUser = String(conn.created_by ?? '').trim();
      void this.operatorNotify.notify({
        projectId: conn.project_id,
        userId: notifyUser,
        title: 'Webhook: circuit breaker открыт',
        body: `Подключение «${conn.id}» остановлено после ${failures} сбоев.`,
        data: { connection_id: conn.id, failures },
        idempotencyKey: `automation.breaker_opened:${conn.project_id}:${conn.id}:${now}`,
      });
    }
  }

  /** Create a project-scoped DLQ row for a failed/deferred external action. */
  private async toDlq(
    index: number,
    type: string,
    action: Record<string, unknown>,
    ctx: DispatchContext,
    lastError: string,
    connectionId?: string,
    httpCode?: number,
  ): Promise<string | undefined> {
    // DLQ-retry path: the caller updates the existing row — never mint a twin.
    if (ctx.skipDlq) return undefined;
    const now = Date.now();
    const id = newEntityId();
    // TODO-041: schedule the FIRST auto-retry here. `next_retry_at` existed and
    // was even returned on the wire, but nothing ever wrote it on insert and
    // nothing polled it — so a failed action sat in the DLQ until a human
    // noticed. Only a retryable failure gets a schedule; a config error stays at
    // 0 (visible, manually retryable, never auto-hammered).
    // The cap is per-row, not global: an AMBIGUOUS failure of an external-effect
    // action (timeout / socket hang up — the request was already on the wire)
    // gets a single automatic re-send instead of the full ladder, because "I do
    // not know whether it arrived" is not "it definitely did not". See
    // {@link attemptCapFor}.
    const cap = attemptCapFor({ action_type: type }, lastError, httpCode);
    const retryable = isRetryableFailure(lastError, httpCode);
    await this.mongo.dlq().insertOne({
      _id: new ObjectId(),
      id,
      project_id: ctx.projectId,
      execution_id: ctx.executionId,
      rule_id: ctx.ruleId,
      action_index: index,
      action_type: type,
      action_config_json: JSON.stringify(action),
      connection_id: connectionId ?? '',
      payload_json: JSON.stringify(ctx.payload ?? {}),
      // Actor of the ORIGINAL dispatch, replayed verbatim by the retry engine.
      // Without it a retry of a user-initiated action would re-run under the
      // system scope, i.e. a transient failure would silently PROMOTE the run
      // past the caller's visibility (§3.8). A stale caller scope is strictly
      // narrower than `mode:'all'`; when it is gone the retry fails closed.
      actor: ctx.actor ?? 'user',
      actor_user_id: ctx.userId ?? '',
      actor_visibility_scope: ctx.visibilityScope ?? '',
      status: 'failed',
      attempts: 1,
      retry_generation: Number(ctx.retryGeneration ?? 0) || 0,
      max_attempts: cap,
      last_error: lastError,
      last_http_code: httpCode ?? 0,
      next_retry_at: retryable && cap > 1 ? now + backoffMs(1) : 0,
      created_at: now,
      updated_at: now,
    });
    return id;
  }

  private aggregate(results: ActionResult[]): ExecutionOutcome {
    return aggregateActionResults(results);
  }
}

/**
 * Aggregate per-action outcomes into an execution status. Shared by the flat
 * dispatcher and the v2 graph executor so both engines report identically.
 */
export function aggregateActionResults(results: ActionResult[]): ExecutionOutcome {
  const effective = results.filter((r) => r.status !== 'skipped');
  if (effective.length === 0) return 'skipped';
  const failed = effective.filter((r) => r.status === 'fail' || r.status === 'deferred').length;
  if (failed === 0) return 'success';
  if (failed === effective.length) return 'fail';
  return 'partial_fail';
}
