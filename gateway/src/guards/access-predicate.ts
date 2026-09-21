/**
 * Gateway-side ABAC predicate compilation (RFC-5 §1.4, RFC-ABAC §2/§7, FR-ABAC-6).
 *
 * The gateway compiles the project's conditional module-policy rules into a single
 * `CompiledPredicate` and carries it to CRM domains in `x-access-predicate`. Domains
 * AND `CompiledPredicate.mongo` into their `{ projectId } AND (visibility OR sharing)`
 * read filter (`composeAccessFilter`) — no record ever leaves the DB just to be
 * filtered out in memory (US-ABAC-M3, non-договорной #6).
 *
 * Normative effect × condition semantics (FR-ABAC-6, permission-abac-visibility/TZ):
 *
 *   | effect | condition | contribution to the readable-set predicate |
 *   |--------|-----------|---------------------------------------------|
 *   | allow  | present   | AND  condition        (restricting grant)   |
 *   | deny   | present   | AND  NOT condition    (exclude matches)     |
 *   | allow  | none `{}` | no-op (ignored here)                        |
 *   | deny   | none `{}` | blanket subject/action deny — enforced by   |
 *   |        |           | ProjectAccessGuard.isDeniedByPolicy (403),  |
 *   |        |           | NOT a row predicate (ignored here). On       |
 *   |        |           | AGGREGATE routes, whose subject is           |
 *   |        |           | `statistics`/`reports` and whose data comes  |
 *   |        |           | from other subjects, the 403 never fires for |
 *   |        |           | a denied SOURCE, so it becomes a deny-all    |
 *   |        |           | source fragment (access-predicate.aggregate) |
 *
 * `deny` wins over `allow` naturally: a record must satisfy every allow condition AND
 * match no deny condition, so a record inside both an allow and a deny is excluded
 * (FR-ABAC-10, deny>allow; order-independent).
 *
 * v1 emission shape: `{ ir: null, mongo }`. We emit ONLY the Mongo fragment (the sole
 * form all CRM consumers apply — list/get filter path; the `.ir` gate path treats a
 * `.ir=null` predicate as "pass" and re-applies `.mongo` on its read, so get-by-id is
 * still narrowed). Emitting `.mongo` alone also sidesteps the IR `not`-lowering limit
 * (`normalizeAbac` supports `not` only over eq/in), because a `deny` exclusion is
 * expressed at the Mongo level as `{ $nor: [<compiled condition>] }`.
 *
 * Fail-safety (RFC-ABAC §4, task gate): this NEVER emits a malformed or partial
 * predicate. If a rule of the ROUTE'S OWN action cannot be faithfully compiled on the
 * gateway — a parse/compile error, or a reference to a context attribute the gateway
 * cannot resolve (see UNRESOLVABLE_CONTEXT_REFS) — the WHOLE predicate is dropped
 * (returns `undefined`, header omitted). An absent header = "no ABAC narrowing",
 * exactly the pre-push-down behaviour (projectId + visibility still enforced by the
 * domain), so dropping is a conscious fail-open-to-current-behaviour, never a wider
 * grant than today and never a corrupted deny.
 *
 * The one set compiled INDEPENDENTLY is the `read` narrowing borrowed by read-shaped
 * routes (READ_SHAPED_ACTIONS): it is an ADDITIONAL restriction layered on top of the
 * route's own rules, so an uncompilable `read` rule may only cost that extra layer —
 * it must not take the route's own predicate down with it (that would make an export
 * WIDER than before the borrowing existed). Dropping the borrowed layer is also
 * consistent with the `read` route itself: there the same rule defers the predicate
 * for the very same reason, so screen and export end up equally wide, never the
 * "screen narrowed / export full" bypass this mapping exists to close.
 */
import {
  parseAbac,
  normalizeAbac,
  resolveContextRefs,
  compileMongo,
  serializeCompiledPredicate,
  refNamespace,
  dataSubjectOwnerField,
  withRecordOwnerAbacShortCircuit,
  type AbacEvalContext,
  type AbacNode,
  type AbacOperand,
} from '@fairflow/shared';

/** Minimal view of a stored module-policy rule (wire shape; single-word fields). */
export type AbacPolicyRule = {
  effect?: string;
  subject?: string;
  action?: string;
  resource?: string;
  condition?: Record<string, unknown>;
};

/**
 * Context attributes the gateway CANNOT resolve at request time in wave 1: department
 * membership and project ownership live in control's DB and are not propagated to the
 * gateway. A rule that references any of them cannot be partial-evaluated here — the
 * whole predicate is deferred (header omitted) rather than compiled against a wrong
 * (empty) value, which could silently widen or narrow access. `user.id`, `user.role`
 * and `project.id` ARE available and stay resolvable.
 */
const UNRESOLVABLE_CONTEXT_REFS = new Set([
  'user.departmentId',
  'user.departmentChain',
  'user.leaderOfDepartmentIds',
  'project.ownerType',
  'project.ownerId',
]);

/** True iff the rule carries a non-empty ABAC condition (vs a plain flat allow/deny). */
export function hasCondition(rule: AbacPolicyRule): boolean {
  return (
    rule.condition != null &&
    typeof rule.condition === 'object' &&
    Object.keys(rule.condition).length > 0
  );
}

/** Alias used by the access PEP layer (`project-access.guard.ts`). */
export const hasAbacCondition = hasCondition;

/**
 * FR-ACCESS-220: conditional deny on a write/create route cannot be evaluated
 * against a not-yet-existing record — treat as unconditional deny (fail-closed).
 */
export function hasConditionalDenyForAction(
  rules: AbacPolicyRule[],
  subject: string,
  action: string,
): boolean {
  const actions = new Set([action]);
  return rules.some(
    (r) => r.effect === 'deny' && hasCondition(r) && ruleTargets(r, subject, actions),
  );
}

/**
 * Route actions that are `read` in disguise: they return the SAME record set a
 * `read` route returns, only in another representation (CSV/XLSX/JSON dump). The
 * row-level narrowing an admin writes as `subject:read` MUST therefore apply to
 * them too — otherwise the control is bypassed by switching the route: the screen
 * (`GET /statistics`, `@RequirePermission('statistics','read')`) shows the narrowed
 * set while `GET /statistics/export` (`…,'export'`) streams the full one, same for
 * `POST /reports/:id/export`.
 *
 * Only the PREDICATE (which rows may be read) is expanded, never the RBAC gate:
 * `statistics:export` stays a separate, elevated permission (permission-rbac.ts,
 * ELEVATED_EXPORT_SUBJECTS) and a project-wide DENY still matches on the route's own
 * action. And the expansion is narrowing-only: fragments from both the route's own
 * action rules and the `read` rules are AND-ed together (see compileAccessPredicate),
 * so an export can only ever see LESS than before this mapping, never more.
 */
const READ_SHAPED_ACTIONS: ReadonlySet<string> = new Set(['export']);

/**
 * Actions whose conditional rules must contribute to the predicate of a route
 * declared with `action`. Identity for every action except the read-shaped ones,
 * which additionally pull in the subject's `read` rules (see READ_SHAPED_ACTIONS).
 */
export function predicateActionsForRoute(action: string): ReadonlySet<string> {
  return READ_SHAPED_ACTIONS.has(action) ? new Set([action, 'read']) : new Set([action]);
}

/**
 * The rule TARGETS (subject, action) — subject/action/resource matching only, without
 * asking whether it carries a condition. Split out of `ruleApplies` because the two
 * halves of the effect × condition table need the same targeting test: conditional
 * rules become row predicates here, while a conditionless `deny` is a blanket deny
 * (enforced as 403 on the subject's own route, and as a deny-all source fragment on
 * aggregate routes — see access-predicate.aggregate.ts). Keeping the match in ONE
 * place is what makes those two paths agree on which rule hits which subject.
 */
export function ruleTargets(
  rule: AbacPolicyRule,
  subject: string,
  actions: ReadonlySet<string>,
): boolean {
  return (
    rule.subject === subject &&
    ((rule.action !== undefined && actions.has(rule.action)) || rule.action === '*') &&
    (!rule.resource || rule.resource === '*' || rule.resource === subject)
  );
}

/**
 * A conditional rule applies to (subject, action) — mirrors PDP `evalAbacLayer`,
 * modulo the read-shaped-action expansion above (`actions` is normally a single
 * action; on an export route it is `{export, read}`).
 */
function ruleApplies(rule: AbacPolicyRule, subject: string, actions: ReadonlySet<string>): boolean {
  return hasCondition(rule) && ruleTargets(rule, subject, actions);
}

/** Collect every operand `ref` (namespaced attribute) appearing in an IR tree. */
function collectRefs(node: AbacNode, out: Set<string>): void {
  switch (node.op) {
    case 'and':
    case 'or':
      node.nodes.forEach((n) => collectRefs(n, out));
      return;
    case 'not':
      collectRefs(node.node, out);
      return;
    default: {
      const add = (op: AbacOperand) => {
        if ('ref' in op) out.add(op.ref);
      };
      add(node.left);
      add(node.right);
    }
  }
}

/** Every `ref` in the tree resolves to a context/record namespace the gateway can handle. */
function isResolvableOnGateway(node: AbacNode): boolean {
  const refs = new Set<string>();
  collectRefs(node, refs);
  for (const ref of refs) {
    if (UNRESOLVABLE_CONTEXT_REFS.has(ref)) return false;
    // `record.*` stays residual; `user.*`/`project.*` not in the unresolvable set are
    // resolvable here (id/role). An unknown namespace would throw at resolve time and
    // is caught by the caller's try/catch.
    const ns = refNamespace(ref);
    if (ns !== 'record' && ns !== 'user' && ns !== 'project') return false;
  }
  return true;
}

/** Правило не компилируется на gateway (битое условие / нерезолвимый контекст). */
const FRAGMENT_FAILED = Symbol('abac-fragment-failed');
/** Правило вакуумно (always-true) — сужать нечем, фрагмент не нужен. */
const FRAGMENT_VACUOUS = Symbol('abac-fragment-vacuous');

/**
 * Компиляция ОДНОГО правила в mongo-фрагмент читаемого множества.
 * Вынесено из тела цикла, чтобы наборы правил (своё действие / заимствованный
 * `read`) компилировались независимо и падение одного набора не роняло другой.
 */
function compileRuleFragment(
  rule: AbacPolicyRule,
  ctx: AbacEvalContext,
): Record<string, unknown> | typeof FRAGMENT_FAILED | typeof FRAGMENT_VACUOUS {
  let parsed: AbacNode;
  try {
    parsed = parseAbac(rule.condition as Record<string, unknown>);
  } catch {
    return FRAGMENT_FAILED; // uncompilable condition.
  }
  if (!isResolvableOnGateway(parsed)) return FRAGMENT_FAILED; // needs unavailable context.

  let mongo: Record<string, unknown>;
  try {
    const residual = normalizeAbac(resolveContextRefs(parsed, ctx));
    mongo = compileMongo(residual);
  } catch {
    return FRAGMENT_FAILED; // unknown ref / not-compilable.
  }
  if (!mongo || Object.keys(mongo).length === 0) {
    // A vacuous fragment (always-true) narrows nothing. For an `allow` that means no
    // constraint (as intended); for a `deny` an always-true condition would be a
    // blanket deny already handled by the RBAC-layer policy check.
    return FRAGMENT_VACUOUS;
  }
  const effect = rule.effect === 'deny' ? 'deny' : 'allow';
  return effect === 'deny' ? { $nor: [mongo] } : mongo;
}

export interface CompileAccessPredicateArgs {
  rules: AbacPolicyRule[];
  /** Route subject = ABAC data-subject (e.g. 'deals', 'contacts', 'products'). */
  subject: string;
  /** Route action ('read' | 'write' | ...). Matched against rule.action / '*'. */
  action: string;
  /** Partial-eval context (RFC-ABAC §2): user.id/role + project.id are load-bearing. */
  ctx: AbacEvalContext;
}

/**
 * Outcome of compiling one (subject, action) — the tri-state the single-subject
 * wrapper collapses but a CROSS-ENTITY caller must tell apart:
 *
 *  - `none`        — nothing applicable / nothing to narrow (no header needed);
 *  - `ok`          — a faithful Mongo fragment for the readable set;
 *  - `undecidable` — applicable conditional rules EXIST but cannot be compiled
 *                    here (parse error, or a context attribute the gateway cannot
 *                    resolve). For one subject that means "no narrowing" (today's
 *                    fail-open-to-current behaviour); for a cross-entity read it
 *                    means the subject's rows must be dropped (fail-closed).
 *
 * Read-shaped routes (export) also borrow the subject's `read` narrowing — see
 * READ_SHAPED_ACTIONS. The `read` rules are a separate set: if THEY fail to compile,
 * only that extra layer is dropped and the route keeps its own predicate.
 */
export type AccessPredicateCompilation =
  | { status: 'none' }
  | { status: 'ok'; mongo: Record<string, unknown> }
  | { status: 'undecidable' };

/**
 * Compile the applicable conditional module-policy rules of ONE (subject, action)
 * into a Mongo fragment. Never throws on rule content — an uncompilable rule is
 * reported as `undecidable`, never as a partial (and therefore wrong) fragment.
 */
export function compileAccessPredicateMongo(
  args: CompileAccessPredicateArgs,
): AccessPredicateCompilation {
  const { rules, subject, action, ctx } = args;
  if (!subject || !Array.isArray(rules) || rules.length === 0) return { status: 'none' };

  // Read-shaped routes (export) also carry the subject's `read` narrowing — see
  // READ_SHAPED_ACTIONS: fragments are AND-ed, so this only ever restricts.
  const ownActions: ReadonlySet<string> = new Set([action]);
  const borrowedActions = new Set(
    [...predicateActionsForRoute(action)].filter((a) => !ownActions.has(a)),
  );
  const ownRules = new Set(rules.filter((r) => ruleApplies(r, subject, ownActions)));
  const applicable = rules.filter(
    (r) =>
      ownRules.has(r) || (borrowedActions.size > 0 && ruleApplies(r, subject, borrowedActions)),
  );
  if (applicable.length === 0) return { status: 'none' };

  const compiled: { own: boolean; mongo: Record<string, unknown> }[] = [];
  let borrowedUsable = true;
  for (const rule of applicable) {
    const own = ownRules.has(rule);
    const fragment = compileRuleFragment(rule, ctx);
    if (fragment === FRAGMENT_FAILED) {
      if (own) return { status: 'undecidable' };
      borrowedUsable = false;
      continue;
    }
    if (fragment === FRAGMENT_VACUOUS) continue;
    compiled.push({ own, mongo: fragment });
  }

  const fragments = compiled.filter((f) => f.own || borrowedUsable).map((f) => f.mongo);
  if (fragments.length === 0) return { status: 'none' };
  return { status: 'ok', mongo: fragments.length === 1 ? fragments[0] : { $and: fragments } };
}

export interface CompileAccessPredicateResult {
  /** Serialized predicate, or `undefined` when nothing should be sent. */
  predicate?: string;
  /**
   * True when an applicable conditional DENY rule cannot be compiled on the
   * gateway (unresolvable context). The guard must fail-closed (403) rather than
   * omit the header and widen reads.
   */
  failClosed: boolean;
  /**
   * True when the compiled predicate carries at least one DENY fragment. The
   * predicate is only *advisory* metadata — a domain that does not apply
   * `x-access-predicate` to the operation would silently drop the deny, so the
   * guard must fail-closed unless the (subject, action) is known to be enforced
   * downstream (TODO-112/073 track widening that set).
   */
  denyCompiled: boolean;
}

/**
 * Compile applicable conditional rules with tri-state metadata for the PEP.
 * Uncompilable own-action ALLOW rules are skipped; uncompilable own-action DENY
 * rules set `failClosed`. Borrowed `read` narrowing may be dropped independently
 * (see READ_SHAPED_ACTIONS / compileAccessPredicateMongo).
 */
export function compileAccessPredicateResult(
  args: CompileAccessPredicateArgs,
): CompileAccessPredicateResult {
  const { rules, subject, action, ctx } = args;
  if (!subject || !Array.isArray(rules) || rules.length === 0) {
    return { predicate: undefined, failClosed: false, denyCompiled: false };
  }

  const ownActions: ReadonlySet<string> = new Set([action]);
  const borrowedActions = new Set(
    [...predicateActionsForRoute(action)].filter((a) => !ownActions.has(a)),
  );
  const ownRules = new Set(rules.filter((r) => ruleApplies(r, subject, ownActions)));
  const applicable = rules.filter(
    (r) =>
      ownRules.has(r) || (borrowedActions.size > 0 && ruleApplies(r, subject, borrowedActions)),
  );
  if (applicable.length === 0) {
    return { predicate: undefined, failClosed: false, denyCompiled: false };
  }

  const compiled: { own: boolean; mongo: Record<string, unknown>; isDeny: boolean }[] = [];
  let borrowedUsable = true;
  let failClosed = false;
  for (const rule of applicable) {
    const own = ownRules.has(rule);
    const isDeny = rule.effect === 'deny';
    const fragment = compileRuleFragment(rule, ctx);
    if (fragment === FRAGMENT_FAILED) {
      if (own) {
        if (isDeny) {
          failClosed = true;
        } else if (borrowedActions.size > 0) {
          // Read-shaped routes (export): an uncompilable own-action ALLOW must not
          // fall back to borrowed `read` narrowing alone — that would make export
          // wider than the screen (see access-predicate.export.spec.ts).
          return { predicate: undefined, failClosed: false, denyCompiled: false };
        }
        continue;
      }
      borrowedUsable = false;
      continue;
    }
    if (fragment === FRAGMENT_VACUOUS) continue;
    compiled.push({ own, mongo: fragment, isDeny });
  }

  if (failClosed) return { predicate: undefined, failClosed: true, denyCompiled: false };

  const fragments = compiled.filter((f) => f.own || borrowedUsable);
  if (fragments.length === 0) {
    return { predicate: undefined, failClosed: false, denyCompiled: false };
  }

  const denyCompiled = fragments.some((f) => f.isDeny);
  const mongoBase =
    fragments.length === 1 ? fragments[0].mongo : { $and: fragments.map((f) => f.mongo) };
  const mongo =
    denyCompiled && ctx.user.id
      ? withRecordOwnerAbacShortCircuit(mongoBase, dataSubjectOwnerField(subject), ctx.user.id)!
      : mongoBase;
  return {
    predicate: serializeCompiledPredicate({ ir: null, mongo }),
    failClosed: false,
    denyCompiled,
  };
}

/**
 * Compile the applicable conditional module-policy rules into the serialized
 * `x-access-predicate` header value, or `undefined` when nothing should be sent
 * (no applicable rules, empty predicate, or any uncompilable/unresolvable rule).
 *
 * All-or-nothing by design for ALLOW rules only: an uncompilable allow is skipped.
 * An uncompilable conditional DENY triggers fail-closed at the guard (see
 * `compileAccessPredicateResult`). Borrowed `read` narrowing may be dropped
 * independently (see compileAccessPredicateMongo).
 */
export function compileAccessPredicate(args: CompileAccessPredicateArgs): string | undefined {
  return compileAccessPredicateResult(args).predicate;
}

export interface CompileCrossEntityPredicateArgs {
  rules: AbacPolicyRule[];
  /** Route action ('read' | 'export'): the action the ROWS are returned for. */
  action: string;
  /** Partial-eval context, identical for every subject (same user/project). */
  ctx: AbacEvalContext;
  /** `[data-subject, entityType]` for every type the cross-entity store indexes. */
  subjectEntityTypes: ReadonlyArray<readonly [string, string]>;
  /** True when an unconditional project-wide DENY blocks (subject, action). */
  isBlanketDenied: (subject: string) => boolean;
  /** Document field carrying the entity type (default `entityType`). */
  typeField?: string;
}

/**
 * ABAC push-down for a CROSS-ENTITY route (global search) — review round 1.
 *
 * A cross-entity route has no data-subject of its own: `/search/query` is gated on
 * subject `search`, while the rows it returns belong to `deals`/`contacts`/… . The
 * single-subject compiler therefore found NO applicable rule and emitted no header,
 * so every conditional ABAC rule and every blanket module-policy DENY written for a
 * CRM module was enforced on that module's own routes and bypassed by global search
 * (title/subtitle/path/entity_id of a hidden record leaked through the search box).
 *
 * Here each indexed data-subject is compiled on its own and contributed as ONE
 * `entityType`-guarded disjunct, so the emitted fragment reads:
 *
 *   { $or: [ { entityType: 'contact' },                       // nothing to narrow
 *            { $and: [ { entityType: 'deal' }, <deal ABAC> ] },
 *            ... ] }                                          // denied types: absent
 *
 * ANDed into the store's read filter this applies each subject's rules inside its
 * own type and — because a row's type must match SOME disjunct — excludes every
 * subject that was dropped. Subjects are dropped when:
 *  - an unconditional DENY blocks (subject, action) — the same rule that 403s the
 *    module's own route must not be searchable around, and
 *  - the subject's rules are `undecidable` — we cannot honour them, and a
 *    cross-entity aggregate must show less rather than leak (fail-closed). This is
 *    deliberately STRICTER than the single-subject path, whose fallback ("no
 *    narrowing") is only safe because that route still returns one known subject.
 *
 * Returns `undefined` when nothing narrows anything (no denies, no conditional
 * rules) so the header stays absent and the request is byte-identical to today.
 * When EVERY subject is dropped it returns a fragment that matches nothing rather
 * than nothing at all — an empty `$or` is not valid Mongo and "no header" would be
 * fail-open.
 */
export function compileCrossEntityAccessPredicate(
  args: CompileCrossEntityPredicateArgs,
): string | undefined {
  const { rules, action, ctx, subjectEntityTypes, isBlanketDenied } = args;
  const typeField = args.typeField ?? 'entityType';

  const branches: Record<string, unknown>[] = [];
  let narrows = false;
  for (const [subject, entityType] of subjectEntityTypes) {
    if (isBlanketDenied(subject)) {
      narrows = true; // blanket DENY → the type contributes no disjunct at all.
      continue;
    }
    const compiled = compileAccessPredicateMongo({ rules, subject, action, ctx });
    if (compiled.status === 'undecidable') {
      narrows = true; // cannot honour the rule → drop the type (fail-closed).
      continue;
    }
    if (compiled.status === 'ok') {
      narrows = true;
      branches.push({ $and: [{ [typeField]: entityType }, compiled.mongo] });
    } else {
      branches.push({ [typeField]: entityType });
    }
  }

  if (!narrows) return undefined; // nothing to say — keep the header absent.
  const mongo =
    branches.length === 0
      ? { [typeField]: { $in: [] as string[] } } // everything dropped → match nothing.
      : branches.length === 1
        ? branches[0]
        : { $or: branches };
  return serializeCompiledPredicate({ ir: null, mongo });
}
