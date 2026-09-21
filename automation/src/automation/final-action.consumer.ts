import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ObjectId } from 'mongodb';
import { randomUUID } from 'node:crypto';
import type { ConsumeMessage } from 'amqplib';
import {
  EVENT_VERSION,
  assertPublishKey,
  busQueueName,
  readRetryCount,
  type EventEnvelope,
} from '@fairflow/shared';
import { MongoService } from '../mongo/mongo.service';
import { RabbitMqService, type ConsumeDisposition } from '../messaging/rabbitmq.service';
import { ActionDispatcher, type ActionResult } from './action-dispatcher.service';
import { ModuleRuntimeGate } from './module-runtime-gate.service';
import { EMAIL_TRANSIENT_ERROR } from './executors/email-executor';
import { isTransientExecutorError } from './executors/executor-errors';

export const FINAL_ACTION_REQUESTED_KEY = 'crm.order.final_action_requested';
export const FINAL_ACTION_SUCCEEDED_KEY = 'crm.order.final_action_succeeded';
export const FINAL_ACTION_FAILED_KEY = 'crm.order.final_action_failed';

/**
 * Delivery budget: the first delivery + the shared bounded-retry ladder
 * (`DLQ_RETRY_LEVELS_MS` = 30s → 60s → 300s, an exponential backoff). A
 * transient failure climbs the ladder; once the budget is spent the terminal
 * `crm.order.final_action_failed` is published (never a silent drop).
 */
const MAX_DELIVERIES = 4;

/** Payload of `crm.order.final_action_requested` (orders moveOrder/retryFinalAction). */
interface FinalActionRequestPayload {
  orderId?: string;
  actionId?: string;
  idempotencyKey?: string;
  retryPolicy?: { maxAttempts?: number } | null;
  /** Full finalActionSpec of the pinned order-type revision (type + config). */
  spec?: { type?: string; config?: Record<string, unknown> } | null;
  assigneeId?: string;
  payload?: { snapshot?: Record<string, unknown> };
}

/** Terminal outcome of one delivery (exposed for unit tests). */
export type FinalActionOutcome = ConsumeDisposition;

type MappedAction =
  | { actionType: string; action: Record<string, unknown> }
  | { error: string };

/**
 * Executor of the order final-action saga (FR-ORDERS-270, OQ-ORDERS-020 —
 * owner decision: lives in the `automation` domain for configurability).
 *
 * Consumes `crm.order.final_action_requested`, executes the order type's
 * `finalActionSpec` (webhook / task / email / none) through the existing
 * {@link ActionDispatcher} (same anti-SSRF allowlist, timeout and
 * circuit-breaker as rule actions), and answers with
 * `crm.order.final_action_succeeded` / `_failed` so orders can complete the
 * `SENDING → DONE | SEND_ERROR` transition (FR-ORDERS-280/290). Guarantees:
 *
 *  - **exactly-once per attempt**: the `automation_final_actions` doc is keyed
 *    by the business `idempotencyKey` (unique index); each delivery claims its
 *    attempt number, so a duplicate delivery neither re-fires the webhook nor
 *    double-publishes the answer;
 *  - **anti-SSRF**: a webhook spec must reference a project connection
 *    (`connection_id`/`urlRef`) from the allowlist — a raw URL in the spec is
 *    refused (`webhook_connection_required`), so the deny-list (private
 *    ranges, link-local 169.254.0.0/16, metadata IP) plus the send-time DNS
 *    re-check of the dispatcher always apply; the outbound body carries the
 *    `idempotency_key` so the receiver can dedup redeliveries;
 *  - **bounded exponential retry**: transient failures (timeout / 5xx /
 *    network / open breaker) requeue onto the shared retry ladder
 *    (30s → 60s → 300s) up to `min(retryPolicy.maxAttempts, 4)` deliveries;
 *    config errors fail terminally at once;
 *  - **module freeze is explicit, not a black hole**: when the `automation`
 *    module is disabled for the project the request is answered with a
 *    terminal `_failed` (`автоматизация выключена…`) instead of being silently
 *    frozen — the order lands in `SEND_ERROR` with a human-readable
 *    `lastError` and stays retryable, never stuck in `SENDING`.
 */
@Injectable()
export class FinalActionConsumerService implements OnModuleInit {
  private readonly logger = new Logger(FinalActionConsumerService.name);

  constructor(
    private readonly rabbit: RabbitMqService,
    private readonly mongo: MongoService,
    private readonly dispatcher: ActionDispatcher,
    private readonly gate: ModuleRuntimeGate,
  ) {}

  async onModuleInit(): Promise<void> {
    const queue =
      process.env.AUTOMATION_FINAL_ACTION_QUEUE ?? busQueueName('automation.final-action');
    const maxAttempts = Number(process.env.AUTOMATION_SUBSCRIBE_RETRIES ?? 10);
    const delayMs = Number(process.env.AUTOMATION_SUBSCRIBE_RETRY_MS ?? 3000);
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        await this.rabbit.consumeEnvelope(queue, [FINAL_ACTION_REQUESTED_KEY], (env, msg) =>
          this.handle(env, msg),
        );
        this.logger.log(`final-action consumer bound queue=${queue}`);
        return;
      } catch (error) {
        this.logger.error(
          `Failed to start final-action consumer on ${queue} (attempt ${attempt}/${maxAttempts}): ${String(error)}`,
        );
        if (attempt < maxAttempts) await new Promise((r) => setTimeout(r, delayMs));
      }
    }
    this.logger.error(
      `final-action consumer could not bind ${queue} after retries; RabbitMqService reconnect will keep trying`,
    );
  }

  /**
   * Handle one `crm.order.final_action_requested` delivery. Returns the broker
   * disposition: `ack` (done / duplicate), `requeue` (transient, climb the
   * ladder), `dead` (poison).
   */
  async handle(
    envelope: EventEnvelope,
    message: Pick<ConsumeMessage, 'properties'>,
  ): Promise<ConsumeDisposition> {
    const projectId = String(envelope.projectId ?? '').trim();
    const p = (envelope.payload ?? {}) as FinalActionRequestPayload;
    const orderId = typeof p.orderId === 'string' ? p.orderId.trim() : '';
    const idemKey =
      (typeof p.idempotencyKey === 'string' && p.idempotencyKey.trim()) ||
      (typeof envelope.idempotencyKey === 'string' ? envelope.idempotencyKey.trim() : '');
    if (!projectId || !orderId || !idemKey) {
      this.logger.error(
        `final_action_requested without projectId/orderId/idempotencyKey (msg=${envelope.messageId ?? '?'}) — dead-lettering`,
      );
      return 'dead';
    }

    // Attempt number of THIS delivery (0-based: first delivery = 0, ladder
    // redeliveries increment via the shared retry headers).
    const attempt = readRetryCount(
      (message.properties?.headers ?? {}) as Record<string, unknown>,
    );

    // Exactly-once claim per (idempotencyKey, attempt): a duplicate delivery of
    // the same attempt — or any delivery after the terminal outcome — is a no-op.
    if (!(await this.claim(projectId, orderId, idemKey, attempt))) {
      this.logger.debug(`duplicate final-action delivery ${idemKey} attempt ${attempt} — ack`);
      return 'ack';
    }

    // Module freeze (FR-LIFE-17): answer explicitly instead of dropping — a
    // frozen executor must not leave the order in SENDING forever. Terminal by
    // design: re-enabling the module + RetryFinalAction resends with a fresh key.
    if (!(await this.gate.isAutomationRuntimeActive(projectId))) {
      const error =
        'автоматизация выключена в проекте: финальное действие не выполнено (включите модуль и повторите отправку)';
      await this.finish(idemKey, 'failed', {
        at: Date.now(),
        attempt_no: attempt + 1,
        error,
        http_code: 0,
        duration_ms: 0,
      });
      await this.publishAnswer(FINAL_ACTION_FAILED_KEY, envelope, projectId, orderId, idemKey, {
        attemptNo: attempt + 1,
        error,
        assigneeId: p.assigneeId,
      });
      return 'ack';
    }

    const spec = p.spec && typeof p.spec === 'object' ? p.spec : { type: p.actionId };
    const type = String(spec.type ?? p.actionId ?? 'none').trim().toLowerCase() || 'none';
    const started = Date.now();
    const result = await this.execute(type, spec.config ?? {}, {
      projectId,
      orderId,
      idemKey,
      assigneeId: p.assigneeId,
      snapshot: p.payload?.snapshot ?? {},
    });
    const durationMs = Date.now() - started;
    const attemptEntry = {
      at: Date.now(),
      attempt_no: attempt + 1,
      error: result.status === 'success' ? '' : (result.error ?? 'final_action_failed'),
      http_code: result.http_code ?? 0,
      duration_ms: durationMs,
    };

    if (result.status === 'success') {
      await this.finish(idemKey, 'succeeded', attemptEntry);
      await this.publishAnswer(FINAL_ACTION_SUCCEEDED_KEY, envelope, projectId, orderId, idemKey, {
        attemptNo: attempt + 1,
        httpCode: result.http_code,
        durationMs,
        assigneeId: p.assigneeId,
      });
      return 'ack';
    }

    // Failure: transient errors climb the bounded ladder (exponential backoff);
    // config/permanent errors and an exhausted budget answer terminally.
    const maxDeliveries = this.maxDeliveries(p.retryPolicy);
    if (this.isTransient(result) && attempt + 1 < maxDeliveries) {
      await this.recordAttempt(idemKey, attemptEntry);
      this.logger.warn(
        `final action ${idemKey} attempt ${attempt + 1}/${maxDeliveries} failed (${attemptEntry.error}); requeue`,
      );
      return 'requeue';
    }
    await this.finish(idemKey, 'failed', attemptEntry);
    await this.publishAnswer(FINAL_ACTION_FAILED_KEY, envelope, projectId, orderId, idemKey, {
      attemptNo: attempt + 1,
      error: attemptEntry.error,
      httpCode: result.http_code,
      durationMs,
      assigneeId: p.assigneeId,
    });
    return 'ack';
  }

  /** Map the finalActionSpec onto the dispatcher and run it (no external effect on mapping errors). */
  private async execute(
    type: string,
    config: Record<string, unknown>,
    ctx: {
      projectId: string;
      orderId: string;
      idemKey: string;
      assigneeId?: string;
      snapshot: Record<string, unknown>;
    },
  ): Promise<ActionResult> {
    if (type === 'none') {
      // Defensive: orders resolves `none` to DONE itself and never publishes it.
      return { index: 0, type: 'none', status: 'success', attempts: 1 };
    }
    const mapped = this.mapAction(type, config);
    if ('error' in mapped) {
      return { index: 0, type, status: 'fail', attempts: 1, error: mapped.error };
    }
    return this.dispatcher.dispatchOne(mapped.actionType, mapped.action, {
      projectId: ctx.projectId,
      ruleId: '',
      executionId: `final-action:${ctx.idemKey}`,
      source: 'order_final_action',
      // The outbound payload carries the business idempotency_key so the
      // receiving system can dedup a redelivered attempt (NFR-820).
      payload: {
        order_id: ctx.orderId,
        idempotency_key: ctx.idemKey,
        assignee_id: ctx.assigneeId ?? '',
        snapshot: ctx.snapshot,
      },
      // Order final-action saga: driven by the order domain over the bus, no end
      // user in the loop and no client-supplied target — the s2s scope applies.
      actor: 'system',
      userId: '',
      // Failures surface on the ORDER (SEND_ERROR + attempts/lastError), not as
      // automation DLQ rows — one source of truth for the final-action log.
      skipDlq: true,
    });
  }

  private mapAction(type: string, config: Record<string, unknown>): MappedAction {
    switch (type) {
      case 'webhook': {
        // Anti-SSRF (FR-ORDERS-035 / contract §7 gate 9): the endpoint MUST be a
        // reference into the project connection allowlist; a raw URL in the spec
        // is refused so the deny-list can never be bypassed by type config.
        const connectionId = String(
          config.connection_id ?? config.connectionId ?? config.urlRef ?? config.url_ref ?? '',
        ).trim();
        if (!connectionId) return { error: 'webhook_connection_required' };
        return { actionType: 'send_webhook', action: { connection_id: connectionId } };
      }
      case 'task':
        return { actionType: 'create_activity', action: { config } };
      case 'email':
        // Handled by EmailExecutor → notification.SendTransactionalEmail
        // (TODO-039). `config` stays nested: the executor reads `{to, subject,
        // template}` from it and renders the snapshot placeholders.
        return { actionType: 'send_email', action: { config } };
      default:
        return { error: `unsupported_final_action:${type}` };
    }
  }

  /** Delivery budget: `retryPolicy.maxAttempts` clamped to the ladder (1..4). */
  private maxDeliveries(retryPolicy: FinalActionRequestPayload['retryPolicy']): number {
    const raw = Number(retryPolicy?.maxAttempts);
    if (!Number.isFinite(raw) || raw < 1) return MAX_DELIVERIES;
    return Math.min(Math.trunc(raw), MAX_DELIVERIES);
  }

  /** Transient = retrying can help: timeout / 5xx / network fault / open breaker. */
  private isTransient(result: ActionResult): boolean {
    const error = String(result.error ?? '');
    if (result.http_code != null && result.http_code >= 500) return true;
    if (/^http_5\d\d$/.test(error)) return true;
    if (error === 'timeout' || error === 'breaker_open') return true;
    // Email transport fault (notification unreachable / deadline / temporary SMTP
    // failure). EVERY other email error code the executor produces is a config
    // error and must stay terminal — see EmailExecutor.interpret.
    if (error.startsWith(EMAIL_TRANSIENT_ERROR)) return true;
    // Same split for the CRM executors (a `task` final action reaches
    // create_activity): only a live transport fault is retryable, every config
    // rejection they report is terminal.
    if (isTransientExecutorError(error)) return true;
    return /ECONNREFUSED|ECONNRESET|ENOTFOUND|EAI_AGAIN|EPIPE|ETIMEDOUT|socket hang up|fetch failed/i.test(
      error,
    );
  }

  /**
   * Claim this (idempotencyKey, attempt) pair. Returns false when the pair was
   * already claimed (duplicate delivery) or the key is already terminal.
   */
  private async claim(
    projectId: string,
    orderId: string,
    idemKey: string,
    attempt: number,
  ): Promise<boolean> {
    const now = Date.now();
    const existing = await this.mongo.finalActions().findOne({ idempotency_key: idemKey });
    if (existing && existing.status !== 'running') return false;
    if (!existing) {
      try {
        await this.mongo.finalActions().insertOne({
          _id: new ObjectId(),
          idempotency_key: idemKey,
          project_id: projectId,
          order_id: orderId,
          status: 'running',
          claims: [attempt],
          attempts: [],
          created_at: now,
          created_dt: new Date(now),
          updated_at: now,
        });
        return true;
      } catch (err) {
        if (!this.isDuplicateKeyError(err)) throw err;
        // Lost the insert race — fall through to the attempt-claim update.
      }
    }
    const res = await this.mongo.finalActions().updateOne(
      { idempotency_key: idemKey, status: 'running', claims: { $ne: attempt } },
      { $addToSet: { claims: attempt }, $set: { updated_at: now } },
    );
    return res.modifiedCount === 1;
  }

  /** Append an attempt to the journal without changing the running status. */
  private async recordAttempt(idemKey: string, attempt: Record<string, unknown>): Promise<void> {
    await this.mongo.finalActions().updateOne(
      { idempotency_key: idemKey },
      // Untyped Collection<Document>: $push on a dynamic field needs the cast.
      { $push: { attempts: attempt }, $set: { updated_at: Date.now() } } as never,
    );
  }

  /** Terminal transition of the journal doc (`succeeded` / `failed`). */
  private async finish(
    idemKey: string,
    status: 'succeeded' | 'failed',
    attempt: Record<string, unknown>,
  ): Promise<void> {
    await this.mongo.finalActions().updateOne(
      { idempotency_key: idemKey },
      // Untyped Collection<Document>: $push on a dynamic field needs the cast.
      { $push: { attempts: attempt }, $set: { status, updated_at: Date.now() } } as never,
    );
  }

  /**
   * Publish the saga answer as a full {@link EventEnvelope} chained to the
   * request (causation/trace/depth) so orders/audit/notification consume the
   * same canonical shape every other producer emits.
   */
  private async publishAnswer(
    key: string,
    request: EventEnvelope,
    projectId: string,
    orderId: string,
    idemKey: string,
    outcome: {
      attemptNo: number;
      error?: string;
      httpCode?: number;
      durationMs?: number;
      assigneeId?: string;
    },
  ): Promise<void> {
    assertPublishKey(key);
    const messageId = randomUUID();
    const envelope: EventEnvelope = {
      type: key,
      version: EVENT_VERSION,
      messageId,
      idempotencyKey: `${key}:${idemKey}`,
      timestamp: new Date().toISOString(),
      source: 'automation',
      traceId: request.traceId ?? request.messageId,
      causationId: request.messageId,
      depth: (Number(request.depth) || 0) + 1,
      projectId,
      actorType: 'service',
      subject: `order/${orderId}`,
      payload: {
        orderId,
        idempotencyKey: idemKey,
        attemptNo: outcome.attemptNo,
        error: outcome.error ?? '',
        httpCode: outcome.httpCode ?? 0,
        durationMs: outcome.durationMs ?? 0,
        assigneeId: outcome.assigneeId ?? '',
      },
    };
    await this.rabbit.publish(key, envelope as unknown as Record<string, unknown>);
  }

  private isDuplicateKeyError(err: unknown): boolean {
    return (
      typeof err === 'object' &&
      err !== null &&
      'code' in err &&
      (err as { code?: number }).code === 11000
    );
  }
}
