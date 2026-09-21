import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { MongoService } from '../mongo/mongo.service';
import { RabbitMqService } from '../messaging/rabbitmq.service';
import { emitAutomationEvent } from './event-emitter';
import { ActionDispatcher, type ActionResult } from './action-dispatcher.service';
import { ModuleRuntimeGate } from './module-runtime-gate.service';
import { OperatorNotifyService } from './operator-notify.service';
import {
  DLQ_EXHAUSTED,
  attemptCapFor,
  backoffMs,
  isRetryableFailure,
  maxAttempts,
  regeneratePayload,
  type DlqRow,
} from './dlq-retry.policy';

export {
  DLQ_EXHAUSTED,
  DLQ_MANUAL_RETRYABLE,
  backoffMs,
  freshIdempotencyKey,
  isRetryableFailure,
  maxAttempts,
  regeneratePayload,
  type DlqRow,
} from './dlq-retry.policy';

/**
 * DLQ retry engine (TODO-041).
 *
 * Two entry points onto ONE re-dispatch path:
 *  - {@link retry} — the operator's manual `RetryDlq`;
 *  - {@link sweep} — the background auto-retry that finally gives `next_retry_at`
 *    a reader. The column existed and was written; nothing ever polled it, so a
 *    failed external action sat in the DLQ until a human noticed.
 *
 * Guarantees:
 *  - **exactly-one runner per row**: the `failed → retrying` transition is an
 *    atomic conditional update, so two replicas (or a sweep racing a human)
 *    cannot double-fire the external effect;
 *  - **a retry is a NEW delivery**: the replayed payload gets a fresh
 *    `payloadGen:sendGen` generation (see {@link freshIdempotencyKey}) and the
 *    dispatch carries `retryGeneration`, so downstream dedup ledgers treat it as
 *    a distinct attempt instead of swallowing it;
 *  - **bounded**: exponential backoff (30s → 60s → 300s → …, capped) and a hard
 *    attempt cap; the row then goes terminal `exhausted` rather than spinning
 *    forever. A human can still retry an exhausted row explicitly. An AMBIGUOUS
 *    external delivery (timeout: the request was on the wire when it broke) is
 *    bounded harder still — one automatic re-send, see `attemptCapFor`;
 *  - **still wanted**: the rule is re-read before every re-dispatch, so
 *    disabling or deleting it actually stops the queued re-sends instead of
 *    leaving an hour of ladder to fire from a rule nobody owns any more;
 *  - **`retrying` always resolves**: the claim is a LEASE, not a permanent
 *    ownership stamp — see {@link reclaimStuck}. A pod that dies between claim
 *    and settle used to leave the row `retrying` forever (the sweep only looked
 *    at `failed`, and the manual button answers RETRY_IN_PROGRESS), i.e. exactly
 *    the wedge orders' `SendingWatchdogService` exists to prevent.
 */
@Injectable()
export class DlqRetryService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(DlqRetryService.name);
  private timer: NodeJS.Timeout | null = null;
  private sweeping = false;

  private readonly sweepIntervalMs =
    Number(process.env.AUTOMATION_DLQ_SWEEP_INTERVAL_MS ?? 30_000) || 30_000;
  private readonly batchSize = Number(process.env.AUTOMATION_DLQ_SWEEP_BATCH ?? 20) || 20;
  private readonly enabled = (process.env.AUTOMATION_DLQ_AUTORETRY_ENABLED ?? 'true') !== 'false';
  /**
   * Claim lease: a row that has been `retrying` for longer than this is assumed
   * orphaned (the runner died) and is reclaimed. MUST exceed the dispatcher's
   * worst case — one dispatch, no internal retry loop: email executor 30s,
   * gRPC executors 15s, webhook 8s — so a live dispatch is never stolen from
   * under itself. 5 minutes leaves an order of magnitude of headroom.
   */
  private readonly leaseMs =
    Number(process.env.AUTOMATION_DLQ_RETRY_LEASE_MS ?? 300_000) || 300_000;

  constructor(
    private readonly mongo: MongoService,
    private readonly dispatcher: ActionDispatcher,
    private readonly rabbit: RabbitMqService,
    private readonly gate?: ModuleRuntimeGate,
    private readonly operatorNotify?: OperatorNotifyService,
  ) {}

  onModuleInit(): void {
    if (!this.enabled) {
      this.logger.warn('DLQ auto-retry disabled (AUTOMATION_DLQ_AUTORETRY_ENABLED=false)');
      return;
    }
    this.timer = setInterval(() => void this.sweepSafely(), this.sweepIntervalMs);
    // Never keep the process alive purely for the sweeper.
    this.timer.unref?.();
    this.logger.log(`DLQ auto-retry started (every ${this.sweepIntervalMs}ms, batch ${this.batchSize})`);
  }

  onModuleDestroy(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private async sweepSafely(): Promise<void> {
    if (this.sweeping) return; // a slow batch must not stack up behind itself
    this.sweeping = true;
    try {
      await this.sweep();
    } catch (err) {
      this.logger.warn(`DLQ auto-retry sweep failed: ${String(err)}`);
    } finally {
      this.sweeping = false;
    }
  }

  /**
   * One auto-retry pass: pick rows whose `next_retry_at` is due and re-dispatch
   * them, then reclaim rows orphaned in `retrying`. Returns the number of rows
   * attempted (used by tests/metrics).
   */
  async sweep(now = Date.now()): Promise<number> {
    const due = (await this.mongo
      .dlq()
      .find({ status: 'failed', next_retry_at: { $gt: 0, $lte: now } })
      .sort({ next_retry_at: 1 })
      .limit(this.batchSize)
      .toArray()) as unknown as DlqRow[];
    let handled = 0;
    for (const row of due) {
      try {
        // FR-LIFE-17: a frozen project must not fire external effects. FreezeRules
        // already parks its rows as `paused_*`, this is the belt-and-braces check
        // for a row scheduled just before the freeze landed. Fails open (the gate
        // itself does) so a control outage never stalls every retry.
        if (this.gate && !(await this.gate.isAutomationRuntimeActive(row.project_id))) continue;
        const claimed = await this.claim(row.project_id, row.id, 'failed');
        if (!claimed) continue; // lost the race to a human/another replica
        await this.runClaimed(claimed);
        handled += 1;
      } catch (err) {
        this.logger.warn(`DLQ auto-retry of ${row.id} failed: ${String(err)}`);
      }
    }
    return handled + (await this.reclaimStuck(now));
  }

  /**
   * Second half of the pass: rows whose runner never came back.
   *
   * `claim` is a lease keyed on `updated_at`, not a permanent stamp. A process
   * killed between claim and {@link settle} (deploy, OOM, node eviction) leaves
   * `status:'retrying'` with nobody driving it: the due-query above only reads
   * `failed`, `RetryDlq` refuses a `retrying` row with RETRY_IN_PROGRESS, and
   * `next_retry_at` is stale — the row is wedged for good. Once the lease has
   * expired the row is taken over through the SAME atomic `retrying → retrying`
   * conditional update, so two replicas sweeping at once still cannot both fire
   * the effect.
   *
   * The takeover is a re-delivery (at-least-once — like the orders SENDING
   * watchdog): the previous attempt may have reached the peer before the crash.
   * That is why the re-dispatch goes through `claim` → fresh `retry_generation`
   * → fresh `payloadGen:sendGen` key: the peer sees a distinct attempt instead
   * of silently deduping the rescue. A row whose attempt budget is already
   * spent is NOT re-dispatched — it is parked in terminal `exhausted`, visible
   * and manually retryable, so a lease expiry can never mint attempts for free.
   */
  private async reclaimStuck(now: number): Promise<number> {
    const staleBefore = now - this.leaseMs;
    const stuck = (await this.mongo
      .dlq()
      .find({ status: 'retrying', updated_at: { $lte: staleBefore } })
      .sort({ updated_at: 1 })
      .limit(this.batchSize)
      .toArray()) as unknown as DlqRow[];
    let handled = 0;
    for (const row of stuck) {
      try {
        if (this.gate && !(await this.gate.isAutomationRuntimeActive(row.project_id))) continue;
        const claimed = await this.claim(row.project_id, row.id, 'retrying', staleBefore);
        if (!claimed) continue; // another replica reclaimed it, or the runner is alive
        this.logger.warn(
          `DLQ item ${row.id} was stuck in 'retrying' since ${row.updated_at}; lease expired, reclaiming`,
        );
        const attempts = Number(claimed.attempts ?? 1) || 1;
        if (attempts > maxAttempts(claimed)) {
          await this.abandon(claimed, claimed.last_error || 'retry_lease_expired');
        } else {
          await this.runClaimed(claimed);
        }
        handled += 1;
      } catch (err) {
        this.logger.warn(`DLQ reclaim of ${row.id} failed: ${String(err)}`);
      }
    }
    return handled;
  }

  /**
   * Manual retry of one row (`RetryDlq`). Throws nothing — the caller maps the
   * `null` result onto a gRPC FAILED_PRECONDITION.
   */
  async retry(projectId: string, dlqId: string, fromStatus: string): Promise<DlqRow | null> {
    const claimed = await this.claim(projectId, dlqId, fromStatus);
    if (!claimed) return null;
    return this.runClaimed(claimed);
  }

  /**
   * Atomic `<fromStatus> → retrying` claim. Also bumps `attempts` and the retry
   * GENERATION here, so the generation the dispatch uses is the one persisted —
   * a crash between claim and dispatch can never re-use a spent generation.
   *
   * `updated_at` is the lease stamp: refreshing it here both marks the new owner
   * and re-arms the expiry. `staleBefore` (reclaim path only) makes the takeover
   * conditional on the previous lease having actually expired, so the update
   * stays a single atomic compare-and-set even when `fromStatus === 'retrying'`.
   */
  private async claim(
    projectId: string,
    dlqId: string,
    fromStatus: string,
    staleBefore?: number,
  ): Promise<DlqRow | null> {
    const now = Date.now();
    const filter: Record<string, unknown> = {
      project_id: projectId,
      id: dlqId,
      status: fromStatus,
    };
    if (staleBefore !== undefined) filter.updated_at = { $lte: staleBefore };
    const res = await this.mongo.dlq().findOneAndUpdate(
      filter,
      {
        $set: { status: 'retrying', updated_at: now },
        $inc: { attempts: 1, retry_generation: 1 },
      },
      { returnDocument: 'after' },
    );
    return this.unwrap(res);
  }

  /**
   * Park a reclaimed row whose attempt budget is already spent: terminal
   * `exhausted`, no dispatch. Keeps the invariant "`retrying` always resolves"
   * without letting a lease expiry hand out attempts the cap already refused.
   */
  private async abandon(row: DlqRow, error: string): Promise<DlqRow> {
    const now = Date.now();
    const outcome: Partial<DlqRow> = {
      status: DLQ_EXHAUSTED,
      last_error: error,
      next_retry_at: 0,
      max_attempts: maxAttempts(row),
      updated_at: now,
    };
    this.logger.warn(`DLQ item ${row.id} reclaimed with its budget spent → ${DLQ_EXHAUSTED}`);
    await this.mongo
      .dlq()
      .updateOne({ project_id: row.project_id, id: row.id, status: 'retrying' }, { $set: outcome });
    void this.emitDlqExhausted(row, error);
    return { ...row, ...outcome } as DlqRow;
  }

  /** mongodb v6 returns the doc directly; older drivers wrap it in `{value}`. */
  private unwrap(res: unknown): DlqRow | null {
    if (!res) return null;
    if (typeof res === 'object' && 'value' in (res as object)) {
      return ((res as { value?: DlqRow }).value ?? null) as DlqRow | null;
    }
    return res as DlqRow;
  }

  /**
   * Is the rule this row belongs to still allowed to fire?
   *
   * A DLQ row outlives the attempt that created it: between the failure and the
   * re-send (up to an hour on the ladder) an operator can disable or delete the
   * rule — and "disabled" must mean "stops sending", not "stops sending except
   * for whatever is already queued". `deleted` and `disabled` are terminal for
   * the row; a Mongo blip is NOT (it must never read as "the rule is gone"), so
   * it parks the row for a later attempt instead.
   */
  private async ruleGate(row: DlqRow): Promise<'ok' | 'gone' | 'unknown'> {
    const ruleId = String(row.rule_id ?? '').trim();
    // Rows not born from a rule (order final-action saga) have no rule to check.
    if (!ruleId) return 'ok';
    let rule: { enabled?: boolean; state?: string } | null = null;
    try {
      rule = (await this.mongo
        .rules()
        .findOne({ project_id: row.project_id, id: ruleId })) as unknown as {
        enabled?: boolean;
        state?: string;
      } | null;
    } catch (err) {
      this.logger.warn(`DLQ item ${row.id}: rule ${ruleId} could not be read: ${String(err)}`);
      return 'unknown';
    }
    if (!rule) return 'gone';
    if (rule.enabled === false || rule.state === 'disabled') return 'gone';
    // `frozen` is the module/project freeze (FR-LIFE-17). The sweep gate already
    // holds those projects back; a row that raced the freeze waits, it is not
    // burned.
    if (rule.state === 'frozen') return 'unknown';
    return 'ok';
  }

  /**
   * Release a claimed row WITHOUT dispatching it: the retry was refused before
   * any effect was produced, so the claim gives its attempt back (`terminal`
   * rows keep the count only to stay honest about the history).
   */
  private async park(row: DlqRow, error: string, terminal: boolean): Promise<DlqRow> {
    const now = Date.now();
    const attempts = Math.max(1, (Number(row.attempts ?? 1) || 1) - 1);
    const outcome: Partial<DlqRow> = {
      status: 'failed',
      attempts,
      last_error: error,
      next_retry_at: terminal ? 0 : now + backoffMs(attempts),
      updated_at: now,
    };
    this.logger.warn(`DLQ item ${row.id} not re-dispatched: ${error}`);
    await this.mongo
      .dlq()
      .updateOne({ project_id: row.project_id, id: row.id, status: 'retrying' }, { $set: outcome });
    return { ...row, ...outcome } as DlqRow;
  }

  /** Re-dispatch a claimed row and write back its outcome. */
  private async runClaimed(row: DlqRow): Promise<DlqRow> {
    const gate = await this.ruleGate(row);
    if (gate !== 'ok') {
      return this.park(
        row,
        gate === 'gone' ? 'rule_disabled_or_deleted' : 'rule_unavailable',
        gate === 'gone',
      );
    }
    const generation = Number(row.retry_generation ?? 1) || 1;
    const action = this.parseJson(row.action_config_json);
    if (!action.type && !action.id) action.type = row.action_type;
    if (row.connection_id && action.connection_id == null && action.connectionId == null) {
      action.connection_id = row.connection_id;
    }
    // Fresh generation for the replayed payload — see freshIdempotencyKey.
    const payload = regeneratePayload(this.parseJson(row.payload_json), generation);

    let ruleName = '';
    if (row.rule_id) {
      const ruleRow = (await this.mongo
        .rules()
        .findOne(
          { project_id: row.project_id, id: row.rule_id },
          { projection: { name: 1 } },
        )) as { name?: string } | null;
      ruleName = String(ruleRow?.name ?? '');
    }

    const result = await this.dispatcher.dispatchOne(row.action_type, action, {
      projectId: row.project_id,
      ruleId: row.rule_id,
      ruleName,
      executionId: row.execution_id,
      source: 'dlq_retry',
      payload,
      // Re-send the SAME delivery, not a new one: the outbound `deliveryId` and
      // the effect key are built from the action's position in its rule, so a
      // retry of action #2 must run as #2 for a receiver (or an effect ledger)
      // to recognise it as a repeat of what it may have already processed.
      actionIndex: Number(row.action_index ?? 0) || 0,
      // A retry re-runs the ORIGINAL actor, never the system one: a row minted by
      // a user-initiated run (ExecuteRule / HookEvent / ManualRun) must not gain
      // `mode:'all'` visibility just because its first attempt failed (§3.8).
      // Rows without a stored actor (written before the field existed) replay as
      // `user` with no scope, i.e. fail closed.
      actor: row.actor === 'system' ? 'system' : 'user',
      userId: row.actor_user_id ?? '',
      visibilityScope: row.actor_visibility_scope ?? '',
      retryGeneration: generation,
      // The outcome updates THIS row instead of minting a twin.
      skipDlq: true,
    });
    return this.settle(row, result);
  }

  /** Write the retry outcome: resolved / re-scheduled / terminally exhausted. */
  private async settle(row: DlqRow, result: ActionResult): Promise<DlqRow> {
    const now = Date.now();
    const succeeded = result.status === 'success';
    const error = succeeded ? '' : (result.error ?? 'retry_failed');
    const attempts = Number(row.attempts ?? 1) || 1;
    // Effective cap, narrowed for an AMBIGUOUS external delivery (§ attemptCapFor):
    // the budget is the row's, but a "did it arrive?" failure of a webhook/email
    // buys one automatic re-send, not five.
    const cap = attemptCapFor(row, error, result.http_code);

    let status = 'failed';
    let nextRetryAt = 0;
    if (succeeded) {
      status = 'resolved';
    } else if (!isRetryableFailure(error, result.http_code)) {
      // Config error: keep it visible as `failed`, but do not auto-retry it.
      status = 'failed';
    } else if (attempts >= cap) {
      status = DLQ_EXHAUSTED;
      this.logger.warn(
        `DLQ item ${row.id} exhausted after ${attempts}/${cap} attempts (${error})`,
      );
      void this.emitDlqExhausted(row, error);
    } else {
      nextRetryAt = now + backoffMs(attempts);
    }

    const outcome: Partial<DlqRow> = {
      status,
      last_error: error,
      last_http_code: result.http_code ?? 0,
      next_retry_at: nextRetryAt,
      max_attempts: cap,
      updated_at: now,
    };
    const res = await this.mongo
      .dlq()
      .updateOne(
        { project_id: row.project_id, id: row.id, status: 'retrying' },
        { $set: outcome },
      );
    if (res?.matchedCount === 0) {
      // The row left `retrying` under the flying dispatch — `FreezeRules` parks
      // `retrying`/`failed` as `paused_*` (§3.22). Dropping the outcome here
      // would be worse than losing a log line: a SUCCEEDED external effect would
      // stay on screen as pending, and the human retry after unfreeze re-fires
      // it for real (the fresh generation key is deliberately NOT deduped). So a
      // success is written through onto the parked row; a failure keeps the
      // paused state (it is the operator's to resume) and only records the error.
      const parked = ['paused_module_disabled', 'paused_project_archived'];
      await this.mongo.dlq().updateOne(
        { project_id: row.project_id, id: row.id, status: { $in: parked } },
        {
          $set: succeeded
            ? outcome
            : { last_error: error, last_http_code: result.http_code ?? 0, updated_at: now },
        },
      );
      this.logger.warn(
        `DLQ item ${row.id} left 'retrying' during its dispatch; outcome ${status} written to the parked row`,
      );
    }
    return { ...row, ...outcome } as DlqRow;
  }

  private async emitDlqExhausted(row: DlqRow, error: string): Promise<void> {
    try {
      const payload = this.parseJson(row.payload_json);
      await emitAutomationEvent(this.rabbit, {
        type: 'automation.dlq.exhausted',
        projectId: row.project_id,
        subject: `rule/${String(row.rule_id ?? payload.rule_id ?? '')}`,
        payload: {
          dlq_id: row.id,
          rule_id: row.rule_id ?? payload.rule_id,
          action_type: row.action_type ?? payload.action_type,
          last_error: error,
          humanContext: {
            displayName: String(payload.rule_name ?? row.rule_id ?? 'правило'),
          },
        },
        idempotencyKey: `automation.dlq.exhausted:${row.project_id}:${row.id}`,
      });
      const ruleId = String(row.rule_id ?? '').trim();
      let notifyUser = '';
      if (ruleId) {
        const rule = (await this.mongo
          .rules()
          .findOne(
            { project_id: row.project_id, id: ruleId },
            { projection: { notify_on_failure: 1, created_by: 1, name: 1 } },
          )) as { notify_on_failure?: string; created_by?: string; name?: string } | null;
        notifyUser = String(rule?.notify_on_failure ?? rule?.created_by ?? '').trim();
        if (notifyUser && this.operatorNotify) {
          void this.operatorNotify.notify({
            projectId: row.project_id,
            userId: notifyUser,
            title: 'Автоматизация: исчерпаны повторы',
            body: `Действие «${row.action_type}» правила «${rule?.name ?? ruleId}» не выполнено: ${error}`,
            data: { dlq_id: row.id, rule_id: ruleId, last_error: error },
            idempotencyKey: `automation.dlq.exhausted.notify:${row.project_id}:${row.id}`,
          });
        }
      }
    } catch (err) {
      this.logger.warn(
        `automation.dlq.exhausted emit failed (${row.id}): ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  private parseJson(raw: string | undefined): Record<string, unknown> {
    try {
      const parsed: unknown = JSON.parse(raw || '{}');
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : {};
    } catch {
      return {};
    }
  }
}
