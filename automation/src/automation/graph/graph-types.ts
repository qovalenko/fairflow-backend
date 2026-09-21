/**
 * GraphSpec types for automation v2 (control-flow workflow on a graph).
 *
 * Contract: docs/tz/areas/automation-v2/02-backend-contract.md §1.3–1.5.
 * The graph is stored INSIDE the existing `automation_rules` document under
 * `graph_json` (a serialized {@link GraphSpec}) gated by `engine_version` (1|2).
 * No new collections, no DB migration — see PLAN.md §0.
 *
 * Handles are NOT stored: they are derived from `type` + `config` (§1.5) so the
 * declared handles can never drift from the real outputs:
 *   trigger   → 'out'
 *   condition → 'true' | 'false'
 *   branch    → 'case:<key>' (per cases[].key) + 'else'
 *   action    → 'out'
 */

export type NodeType = 'trigger' | 'condition' | 'branch' | 'action';

/** A single node of the workflow graph (§1.3). */
export interface NodeSpec {
  /** Stable FE-generated id, unique within the graph. */
  id: string;
  type: NodeType;
  /** Canvas coordinates — UI-only, execution does not depend on them. */
  position: { x: number; y: number };
  /** Type-specific config (§1.4). condition.predicate carries an AbacNode. */
  config: Record<string, unknown>;
}

/** A directed edge between two node handles (§1.3). */
export interface EdgeSpec {
  /** Unique edge id within the graph. */
  id: string;
  /** Source NodeSpec.id. */
  source: string;
  /** Source output handle: 'out' | 'true' | 'false' | 'case:<key>' | 'else'. */
  sourceHandle: string;
  /** Target NodeSpec.id. */
  target: string;
  /** Target input handle — v2 nodes have a single 'in'; reserved. */
  targetHandle?: string;
}

/** Whole workflow graph (§1.3) — serialized into `automation_rules.graph_json`. */
export interface GraphSpec {
  /** Graph schema version (NOT the rule's engine_version). */
  version: number;
  nodes: NodeSpec[];
  edges: EdgeSpec[];
  /** Canvas viewport — UI-only, execution ignores it. */
  viewport?: { x: number; y: number; zoom: number };
}

/** Severity of a validation issue. `valid=false` iff ≥1 `error`. */
export type GraphIssueSeverity = 'error' | 'warning';

/**
 * One validation finding (contract §2.1 `GraphValidationIssue`).
 * `code` ∈ CYCLE | NO_TRIGGER | MULTIPLE_TRIGGERS | DANGLING_NODE | INVALID_HANDLE |
 *          TYPE_MISMATCH | UNKNOWN_TRIGGER | UNKNOWN_ACTION | CONDITION_NOT_COMPILABLE |
 *          EXTERNAL_EFFECT_REQUIRES_MANAGE | GRAPH_TOO_LARGE | NO_NODES | INVALID_NODE_TYPE | ...
 */
export interface GraphValidationIssue {
  code: string;
  /** '' if the issue is graph-wide. */
  nodeId: string;
  /** '' if the issue is not edge-specific. */
  edgeId: string;
  message: string;
  severity: GraphIssueSeverity;
}

/**
 * Node-type descriptor for the canvas palette (contract §2.3 `NodeTypeDef`).
 * Built from the in-code TRIGGER/ACTION catalogs (registry.ts) plus the static
 * structural condition/branch types.
 */
export interface NodeTypeDef {
  type: NodeType;
  /** trigger_id / action_id (e.g. 'crm.deal.won', 'send_webhook'); '' for structural. */
  subtype: string;
  requiredModule: string;
  /** Action-only: produces an external/irreversible effect (privileged). */
  externalEffect: boolean;
  /** Trigger-only: the entity type the trigger fires for. */
  entityType: string;
  /** JSON-Schema-ish config descriptor (stringified on the wire). */
  configSchema: Record<string, unknown>;
  /** Trigger-only: fields exposed to conditions (record.* / trigger.*). */
  outputSchema: Record<string, unknown>;
  /** Static output handles of the node type. */
  outHandles: string[];
}
