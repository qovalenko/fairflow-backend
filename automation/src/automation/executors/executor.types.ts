/**
 * Who this run belongs to. EXPLICIT on purpose (§3.8 IDOR): the choice between
 * "the caller's own visibility" and the system `mode:'all'` scope must be a
 * declared property of the entry point, never a side effect of `userId` being
 * empty — an entry point that forgot to forward the actor would otherwise
 * inherit the system scope silently.
 *
 *  - `user`   — a run started from a gateway request (ExecuteRule / HookEvent /
 *               ManualRun). The originating caller's scope applies; when it was
 *               not forwarded the run stays fail-closed (targets answer NOT_FOUND).
 *  - `system` — the bus/consumer path, a janitor re-drive or the order
 *               final-action saga: there IS no end user, so the s2s scope applies.
 *
 * Absent ⇒ treated as `user`, i.e. fail-closed.
 */
export type RunActor = 'user' | 'system';

/** Context passed to an executor for one action dispatch (service-actor call). */
export interface ExecutorContext {
  projectId: string;
  /** Who the run belongs to — see {@link RunActor}. Absent ⇒ `user` (fail-closed). */
  actor?: RunActor;
  /** End-user id when the rule was run on a user's behalf; '' on the bus path. */
  userId?: string;
  /** The triggering event / manual-run payload (record snapshot, params). */
  payload: Record<string, unknown>;
  /**
   * Serialized `x-visibility-scope` of the ORIGINATING caller, forwarded verbatim
   * on every `actor:'user'` run (ExecuteRule / HookEvent / ManualRun). Never
   * widened here: a user must not reach a record through a rule that they could
   * not reach directly (§3.8 IDOR). Only an `actor:'system'` run has no caller
   * scope, and only there does `buildServiceActorMetadata` substitute the s2s
   * `mode:'all'` scope.
   */
  visibilityScope?: string;
  /**
   * Entity type the rule's trigger fires on (`deal`, `contact`, …), derived from
   * the trigger catalog. Used to resolve which record an entity-generic action
   * (`assign_user` / `update_field`) targets when the config does not say.
   */
  entityType?: string;
  /**
   * Stable key of THIS effect attempt: `<executionId>:<actionIndex>:<type>:<gen>`
   * where `gen` is the retry generation. Executors whose target mutation is not
   * naturally idempotent (creating a notification) claim it in the effect ledger
   * so a redelivery/janitor re-drive cannot produce the effect twice — while a
   * DLQ retry, which carries a FRESH generation, is meant to run again.
   */
  effectKey?: string;
  /** Originating automation rule id — forwarded to domains as `created_by_rule`. */
  ruleId?: string;
  /** Human-readable rule name for `created_by_rule.name`. */
  ruleName?: string;
  /** Rule author id — assignee fallback chain, not visibility (FR-AUTOM-110). */
  ruleAuthorId?: string;
}

export interface ExecutorOutcome {
  ok: boolean;
  error?: string;
  /** e.g. resolved assignee for assign_user — surfaced in action_results. */
  assignee?: string;
  /**
   * Set when the action was a no-op because the target was ALREADY in the
   * requested state (idempotent replay). Success, but no second effect.
   */
  noop?: boolean;
}

/**
 * A domain executor turns one automation action (`{ type, ...config }`) into a
 * gRPC mutation on its target domain, called with the automation service-actor
 * metadata (FR-MAUT-8/8a). Implementations MUST scope every call to
 * `ctx.projectId` and must NOT take the target endpoint/record from anywhere but
 * the action config + project scope.
 */
export interface ActionExecutor {
  /** Action types this executor can handle. */
  readonly handles: readonly string[];
  execute(
    type: string,
    action: Record<string, unknown>,
    ctx: ExecutorContext,
  ): Promise<ExecutorOutcome>;
}
