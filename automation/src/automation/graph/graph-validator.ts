/**
 * Static graph validator for automation v2 (contract §4).
 *
 * Runs the invariants of a workflow `GraphSpec` BEFORE persisting (Create/Update
 * at engine_version=2) and on-demand via the `ValidateGraph` RPC. Pure & domain-
 * authoritative (PEP): the gateway never sees graph contents, so reject-on-save is
 * the single source of truth. Returns the full list of issues; `valid` iff there
 * is no `error`-severity issue.
 *
 * Invariants (§4.1–4.7):
 *   - exactly one trigger node, it is a source (no incoming edges);
 *   - DAG (no cycles) — reachable nodes only;
 *   - every edge references existing source/target nodes;
 *   - handle typing: edge.sourceHandle ∈ the node's derived out-handles;
 *   - trigger/action subtype ∈ catalog;
 *   - condition.predicate / branch.cases are shape-compilable;
 *   - external-effect action requires `automation:manage` (caller flag);
 *   - node-count limit (DoS guard).
 */
import { ACTION_CATALOG, EXTERNAL_EFFECT_ACTIONS, TRIGGER_CATALOG } from '../registry';
import { validateAbacShape } from './abac-eval';
import type { GraphSpec, GraphValidationIssue, NodeSpec, NodeType } from './graph-types';

const TRIGGER_IDS = new Set(TRIGGER_CATALOG.map((t) => t.id));
const ACTION_IDS = new Set(ACTION_CATALOG.map((a) => a.id));
const NODE_TYPES: ReadonlySet<NodeType> = new Set<NodeType>(['trigger', 'condition', 'branch', 'action']);

const MAX_NODES = Number(process.env.AUTOMATION_GRAPH_MAX_NODES ?? 50) || 50;

export interface ValidateGraphOptions {
  /** Caller has `automation:manage` — required to save graphs with external effects (absent = denied). */
  canManage?: boolean;
  /** Effective enabled module ids for the project (gateway metadata, never from body alone). */
  enabledModules?: string[];
}

/** Output handles a node exposes, derived from its type + config (§1.5). */
export function outHandlesOf(node: NodeSpec): string[] {
  switch (node.type) {
    case 'trigger':
      return ['out'];
    case 'condition':
      return ['true', 'false'];
    case 'branch': {
      const cases = Array.isArray(node.config?.cases) ? (node.config.cases as Array<{ key?: unknown }>) : [];
      const keys = cases.map((c) => `case:${String(c?.key ?? '')}`);
      return [...keys, 'else'];
    }
    case 'action':
      return ['out'];
    default:
      return [];
  }
}

function configString(node: NodeSpec, ...keys: string[]): string {
  const cfg = node.config ?? {};
  for (const k of keys) {
    const v = (cfg as Record<string, unknown>)[k];
    if (v != null && v !== '') return String(v);
  }
  return '';
}

/**
 * Validate a workflow graph. `options.canManage` gates external-effect actions.
 * Pure: never touches Mongo / network.
 */
export function validateGraph(graph: GraphSpec, options: ValidateGraphOptions = {}): GraphValidationIssue[] {
  const issues: GraphValidationIssue[] = [];
  const err = (code: string, message: string, nodeId = '', edgeId = '') =>
    issues.push({ code, nodeId, edgeId, message, severity: 'error' });
  const warn = (code: string, message: string, nodeId = '', edgeId = '') =>
    issues.push({ code, nodeId, edgeId, message, severity: 'warning' });
  const enabled = new Set(
    (options.enabledModules ?? []).map((m) => String(m).trim()).filter(Boolean),
  );
  const checkModule = (requiredModule: string | undefined, nodeId: string, label: string) => {
    if (!requiredModule || enabled.size === 0) return;
    if (!enabled.has(requiredModule)) {
      err(
        'MISSING_DEPENDENCY',
        `${label} requires module "${requiredModule}" which is not enabled in this project`,
        nodeId,
      );
    }
  };

  const nodes = Array.isArray(graph?.nodes) ? graph.nodes : [];
  const edges = Array.isArray(graph?.edges) ? graph.edges : [];

  if (nodes.length === 0) {
    err('NO_NODES', 'graph has no nodes');
    return issues;
  }
  if (nodes.length > MAX_NODES) {
    err('GRAPH_TOO_LARGE', `graph has ${nodes.length} nodes (max ${MAX_NODES})`);
  }

  // ── node index + duplicate-id / unknown-type checks ──────────────────────
  const byId = new Map<string, NodeSpec>();
  for (const n of nodes) {
    if (!n.id) {
      err('INVALID_NODE_TYPE', 'node is missing an id');
      continue;
    }
    if (byId.has(n.id)) {
      err('DUPLICATE_NODE_ID', `duplicate node id "${n.id}"`, n.id);
      continue;
    }
    byId.set(n.id, n);
    if (!NODE_TYPES.has(n.type)) {
      err('INVALID_NODE_TYPE', `unknown node type "${n.type}"`, n.id);
    }
  }

  // ── trigger cardinality (§4.2) ───────────────────────────────────────────
  const triggers = nodes.filter((n) => n.type === 'trigger');
  if (triggers.length === 0) err('NO_TRIGGER', 'graph must have exactly one trigger node');
  else if (triggers.length > 1) {
    err('MULTIPLE_TRIGGERS', `graph has ${triggers.length} trigger nodes (exactly one allowed)`);
  }
  const trigger = triggers[0];
  if (trigger) {
    const triggerId = configString(trigger, 'trigger_id', 'triggerId', 'event_name', 'eventName');
    if (!triggerId || !TRIGGER_IDS.has(triggerId)) {
      err('UNKNOWN_TRIGGER', `unknown trigger_id "${triggerId}"`, trigger.id);
    } else {
      const trig = TRIGGER_CATALOG.find((t) => t.id === triggerId || t.eventName === triggerId);
      checkModule(trig?.requiredModule, trigger.id, `trigger "${triggerId}"`);
    }
  }

  // ── per-node config (action subtype, condition/branch predicates, §4.5) ───
  for (const n of nodes) {
    if (n.type === 'action') {
      const actionId = configString(n, 'action_id', 'actionId', 'type');
      if (!actionId || !ACTION_IDS.has(actionId)) {
        err('UNKNOWN_ACTION', `unknown action_id "${actionId}"`, n.id);
        continue;
      }
      const actionDef = ACTION_CATALOG.find((a) => a.id === actionId);
      checkModule(actionDef?.requiredModule, n.id, `action "${actionId}"`);
      // external-effect → privileged (needs automation:manage) — PEP in domain.
      // Fail-closed: only an explicit `true` opens the gate, so a caller flag lost
      // on the wire denies the save instead of silently granting manage.
      if (EXTERNAL_EFFECT_ACTIONS.has(actionId) && options.canManage !== true) {
        err(
          'EXTERNAL_EFFECT_REQUIRES_MANAGE',
          `action "${actionId}" has an external effect and requires automation:manage`,
          n.id,
        );
      }
      // send_webhook endpoint MUST come from a connection (anti-SSRF §4.6).
      if (actionId === 'send_webhook') {
        const params = (n.config?.params ?? n.config ?? {}) as Record<string, unknown>;
        const connId = String(params.connection_id ?? params.connectionId ?? '').trim();
        if (!connId) {
          err('INVALID_ARGUMENT', 'send_webhook requires config.params.connection_id', n.id);
        }
      }
    } else if (n.type === 'condition') {
      const predicate = (n.config ?? {}).predicate;
      const shapeErr = validateAbacShape(predicate);
      if (shapeErr) err('CONDITION_NOT_COMPILABLE', shapeErr, n.id);
    } else if (n.type === 'branch') {
      const on = configString(n, 'on');
      if (!on) err('CONDITION_NOT_COMPILABLE', 'branch requires config.on', n.id);
      const cases = Array.isArray(n.config?.cases) ? (n.config.cases as Array<Record<string, unknown>>) : [];
      const seen = new Set<string>();
      for (const c of cases) {
        const key = String(c?.key ?? '');
        if (!key) err('CONDITION_NOT_COMPILABLE', 'branch case requires a key', n.id);
        if (seen.has(key)) err('CONDITION_NOT_COMPILABLE', `duplicate branch case key "${key}"`, n.id);
        seen.add(key);
        if (!('equals' in (c ?? {}))) {
          err('CONDITION_NOT_COMPILABLE', `branch case "${key}" requires equals`, n.id);
        }
      }
    }
  }

  // ── edges: existence + handle typing + trigger-as-target (§4.2/4.4) ───────
  const adjacency = new Map<string, string[]>();
  const incoming = new Map<string, number>();
  for (const n of nodes) {
    adjacency.set(n.id, []);
    incoming.set(n.id, 0);
  }
  for (const e of edges) {
    if (!e.id) {
      err('INVALID_HANDLE', 'edge is missing an id');
      continue;
    }
    const src = byId.get(e.source);
    const tgt = byId.get(e.target);
    if (!src) {
      err('INVALID_HANDLE', `edge source "${e.source}" does not exist`, '', e.id);
      continue;
    }
    if (!tgt) {
      err('INVALID_HANDLE', `edge target "${e.target}" does not exist`, '', e.id);
      continue;
    }
    if (tgt.type === 'trigger') {
      err('INVALID_HANDLE', 'an edge cannot target a trigger node', tgt.id, e.id);
      continue;
    }
    const allowed = outHandlesOf(src);
    if (!allowed.includes(e.sourceHandle)) {
      err(
        'INVALID_HANDLE',
        `handle "${e.sourceHandle}" is not valid for ${src.type} node (allowed: ${allowed.join(', ')})`,
        src.id,
        e.id,
      );
      continue;
    }
    adjacency.get(e.source)!.push(e.target);
    incoming.set(e.target, (incoming.get(e.target) ?? 0) + 1);
  }

  // trigger must be a source (no incoming) — §4.2.
  if (trigger && (incoming.get(trigger.id) ?? 0) > 0) {
    err('INVALID_HANDLE', 'trigger node cannot have incoming edges', trigger.id);
  }

  // ── DAG / cycle detection via Kahn topo-sort (§4.1) ───────────────────────
  const indeg = new Map<string, number>(incoming);
  const queue: string[] = [];
  for (const [id, d] of indeg) if (d === 0) queue.push(id);
  let processed = 0;
  while (queue.length) {
    const id = queue.shift()!;
    processed++;
    for (const next of adjacency.get(id) ?? []) {
      const d = (indeg.get(next) ?? 0) - 1;
      indeg.set(next, d);
      if (d === 0) queue.push(next);
    }
  }
  if (processed < byId.size) {
    // Nodes still with indegree > 0 after Kahn participate in a cycle.
    const inCycle = [...indeg.entries()].filter(([, d]) => d > 0).map(([id]) => id);
    err('CYCLE', `graph contains a cycle (nodes: ${inCycle.join(', ')})`, inCycle[0] ?? '');
  }

  // ── reachability from trigger (§4.3) ──────────────────────────────────────
  if (trigger) {
    const reachable = new Set<string>([trigger.id]);
    const stack = [trigger.id];
    while (stack.length) {
      const id = stack.pop()!;
      for (const next of adjacency.get(id) ?? []) {
        if (!reachable.has(next)) {
          reachable.add(next);
          stack.push(next);
        }
      }
    }
    for (const n of nodes) {
      if (n.type === 'trigger') continue;
      if (reachable.has(n.id)) continue;
      const actionId = n.type === 'action' ? configString(n, 'action_id', 'actionId', 'type') : '';
      // A dangling external-effect action is an error (no "dead" webhook §4.3/OQ-5);
      // any other unreachable node is a non-blocking warning.
      if (n.type === 'action' && EXTERNAL_EFFECT_ACTIONS.has(actionId)) {
        err('DANGLING_NODE', `external-effect action "${n.id}" is not reachable from the trigger`, n.id);
      } else {
        warn('DANGLING_NODE', `node "${n.id}" is not reachable from the trigger`, n.id);
      }
    }
  }

  return issues;
}

/** True when the issue list contains no `error`-severity finding. */
export function isGraphValid(issues: GraphValidationIssue[]): boolean {
  return !issues.some((i) => i.severity === 'error');
}
