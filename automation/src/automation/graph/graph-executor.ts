/**
 * Graph executor for automation v2 (TODO-040, FR-AUTOM-490/500/510/530).
 *
 * Executes a saved `GraphSpec` (rule.engine_version=2): walks the DAG from the
 * trigger node, evaluates condition/branch nodes against the event payload via
 * the in-domain ABAC evaluator, and dispatches action nodes through the SAME
 * per-action pipeline as flat (v1) rules — so isolation, anti-SSRF, DLQ and
 * exactly-once semantics of the {@link ActionDispatcher} apply unchanged.
 *
 * The traversal is pure except for the injected `dispatchOne` callback; the
 * validator (reject-on-save §4) guarantees a single trigger and a DAG, but the
 * executor is defensive anyway (visited-set + step cap) so a malformed stored
 * graph can never loop the worker.
 *
 * Routing semantics (§1.5 handles):
 *   trigger   → follow 'out';
 *   condition → evalAbac(config.predicate) → follow 'true' | 'false';
 *   branch    → payload[config.on] compared to cases[].equals (strict) →
 *               follow 'case:<key>' of the FIRST matching case, else 'else';
 *   action    → dispatchOne(action_id, config.params) → follow 'out'
 *               (a failed action does not stop the walk — same as flat rules).
 *
 * The visited node ids are returned as `graph_path` (execution trace for the
 * canvas highlight); the aggregate status mirrors the dispatcher's rules.
 */
import { evalAbac, type AbacEvalNode } from './abac-eval';
import type { GraphSpec, NodeSpec } from './graph-types';
import type { ActionResult } from '../action-dispatcher.service';
import { aggregateActionResults } from '../action-dispatcher.service';
import type { ExecutionOutcome } from '../action-dispatcher.service';

/** Context forwarded verbatim to the dispatcher for every action node. */
export interface GraphRunContext {
  projectId: string;
  ruleId: string;
  /** Denormalized rule title for `created_by_rule` on domain mutations (FR-MAUT-36). */
  ruleName?: string;
  executionId: string;
  source: string;
  payload: Record<string, unknown>;
  /** `user` (gateway-initiated) or `system` (bus/janitor) — see `RunActor`. */
  actor?: 'user' | 'system';
  userId?: string;
  /** Rule author — assignee fallback, not visibility scope (FR-AUTOM-100/110). */
  ruleAuthorId?: string;
  /** Forwarded to the executors — see `DispatchContext` (visibility / targeting). */
  visibilityScope?: string;
  entityType?: string;
  retryGeneration?: number;
  /**
   * Position of the action node being dispatched, filled in per node by
   * {@link executeGraph}. It is the action's IDENTITY downstream — the effect
   * key and the outbound webhook `deliveryId` are built from it — so every node
   * must get its own: dispatching them all as #0 makes two `send_webhook` nodes
   * look like one delivery to a receiver that dedups, and two `send_notification`
   * nodes collide in the effect ledger.
   */
  actionIndex?: number;
  dryRun?: boolean;
}

/** Single-action dispatch callback ({@link ActionDispatcher.dispatchOne}). */
export type DispatchOneFn = (
  type: string,
  action: Record<string, unknown>,
  ctx: GraphRunContext,
) => Promise<ActionResult>;

export interface GraphRunResult {
  status: ExecutionOutcome;
  action_results: ActionResult[];
  /** Node ids in visit order — execution trace for the canvas (FR-AUTOM-530). */
  graph_path: string[];
}

/** Flat field of a possibly namespaced ref ("record.amount" → "amount"). */
function flatField(ref: string): string {
  const dot = ref.indexOf('.');
  return dot >= 0 ? ref.slice(dot + 1) : ref;
}

function actionIdOf(node: NodeSpec): string {
  const cfg = (node.config ?? {}) as Record<string, unknown>;
  return String(cfg.action_id ?? cfg.actionId ?? cfg.type ?? '').trim();
}

function actionParamsOf(node: NodeSpec): Record<string, unknown> {
  const cfg = (node.config ?? {}) as Record<string, unknown>;
  const params = cfg.params;
  if (params && typeof params === 'object' && !Array.isArray(params)) {
    return params as Record<string, unknown>;
  }
  return cfg;
}

/** The single out-handle a condition/branch node activates for this payload. */
function activeHandleOf(node: NodeSpec, payload: Record<string, unknown>): string {
  if (node.type === 'condition') {
    const predicate = (node.config ?? {}).predicate as AbacEvalNode | undefined;
    return evalAbac(predicate ?? null, payload) ? 'true' : 'false';
  }
  // branch: strict comparison of the routed field against each case's `equals`
  // — no coercion (fail-closed to 'else' on any mismatch/missing field).
  const cfg = (node.config ?? {}) as Record<string, unknown>;
  const value = payload[flatField(String(cfg.on ?? ''))];
  const cases = Array.isArray(cfg.cases) ? (cfg.cases as Array<Record<string, unknown>>) : [];
  for (const c of cases) {
    if ('equals' in (c ?? {}) && c.equals === value) return `case:${String(c.key ?? '')}`;
  }
  return 'else';
}

/**
 * Execute a v2 workflow graph. Returns the per-action results (dispatcher
 * shape), the aggregate status and the visited path. A graph with no reachable
 * action nodes yields `skipped` (same as a flat rule with no actions).
 */
export async function executeGraph(
  graph: GraphSpec,
  ctx: GraphRunContext,
  dispatchOne: DispatchOneFn,
): Promise<GraphRunResult> {
  const nodes = Array.isArray(graph?.nodes) ? graph.nodes : [];
  const edges = Array.isArray(graph?.edges) ? graph.edges : [];
  const byId = new Map(nodes.map((n) => [n.id, n] as const));
  const trigger = nodes.find((n) => n.type === 'trigger');

  const results: ActionResult[] = [];
  const path: string[] = [];
  if (!trigger) {
    // Defensive: the validator rejects trigger-less graphs on save.
    return { status: 'skipped', action_results: results, graph_path: path };
  }

  const targetsOf = (nodeId: string, handle: string): string[] =>
    edges.filter((e) => e.source === nodeId && e.sourceHandle === handle).map((e) => e.target);

  // BFS from the trigger. `visited` collapses diamond joins (a node runs at most
  // once per execution) and, together with the step cap, guards against a
  // malformed stored graph looping the worker (validator invariant backstop).
  const visited = new Set<string>();
  const queue: string[] = [trigger.id];
  // Every pop counts as a step; duplicates from diamond joins are popped (and
  // skipped), so the bound is nodes + edges — enough for any legal DAG while
  // still terminating on a malformed graph.
  const maxSteps = nodes.length + edges.length + 1;
  let steps = 0;
  let actionIndex = 0;

  while (queue.length > 0 && steps < maxSteps) {
    steps += 1;
    const id = queue.shift()!;
    if (visited.has(id)) continue;
    visited.add(id);
    const node = byId.get(id);
    if (!node) continue;
    path.push(id);

    let handles: string[];
    switch (node.type) {
      case 'trigger':
        handles = ['out'];
        break;
      case 'condition':
      case 'branch':
        handles = [activeHandleOf(node, ctx.payload)];
        break;
      case 'action': {
        const actionId = actionIdOf(node);
        if (actionId) {
          const action = { ...actionParamsOf(node), type: actionId };
          results.push({
            ...(await dispatchOne(actionId, action, { ...ctx, actionIndex })),
            index: actionIndex,
          });
          actionIndex += 1;
        } else {
          results.push({
            index: actionIndex,
            type: '',
            status: 'skipped',
            attempts: 0,
            error: 'missing_type',
          });
          actionIndex += 1;
        }
        // A failed/deferred action does not stop the remaining flow — identical
        // to the flat dispatcher (its outcome lands in DLQ, §3.7).
        handles = ['out'];
        break;
      }
      default:
        handles = [];
    }
    for (const h of handles) {
      for (const target of targetsOf(id, h)) {
        if (!visited.has(target)) queue.push(target);
      }
    }
  }

  return { status: aggregateActionResults(results), action_results: results, graph_path: path };
}
