/**
 * Mapping between the proto `GraphSpec` message and the internal {@link GraphSpec}
 * + JSON storage form (`automation_rules.graph_json`).
 *
 * The graph travels as a NESTED proto message (`CreateRuleRequest.graph`), NOT a
 * JSON string. The automation microservice does not set `keepCase` on its gRPC
 * loader (default `keepCase:false`), so a field declared `position_x` on the wire
 * is delivered to the handler as `positionX`. The gateway loader uses
 * `keepCase:true` and serializes snake_case. To be robust to BOTH casings (and to
 * future loader changes), every mapper reads snake_case OR camelCase.
 *
 * `config_json` per node is a JSON string on the proto; we parse it into the
 * internal `config: Record<string, unknown>`. On the way out (GetRule) we serialize
 * the stored graph back to the proto shape.
 */
import type { EdgeSpec, GraphSpec, NodeSpec, NodeType } from './graph-types';

type WireNode = {
  id?: string;
  type?: string;
  position_x?: number;
  positionX?: number;
  position_y?: number;
  positionY?: number;
  config_json?: string;
  configJson?: string;
};

type WireEdge = {
  id?: string;
  source?: string;
  source_handle?: string;
  sourceHandle?: string;
  target?: string;
  target_handle?: string;
  targetHandle?: string;
};

type WireGraph = {
  version?: number;
  nodes?: WireNode[];
  edges?: WireEdge[];
  viewport_json?: string;
  viewportJson?: string;
};

function parseJsonObject(raw: string | undefined): Record<string, unknown> {
  if (!raw) return {};
  try {
    const v = JSON.parse(raw);
    if (v && typeof v === 'object' && !Array.isArray(v)) return v as Record<string, unknown>;
  } catch {
    // malformed → empty config (defensive; validator catches bad node config).
  }
  return {};
}

/** Convert a wire (proto) GraphSpec into the internal {@link GraphSpec}. */
export function graphFromWire(wire: WireGraph | undefined | null): GraphSpec | null {
  if (!wire || (!wire.nodes && !wire.edges && !wire.version)) return null;
  const nodes: NodeSpec[] = (wire.nodes ?? []).map((n) => ({
    id: String(n.id ?? ''),
    type: String(n.type ?? '') as NodeType,
    position: {
      x: Number(n.position_x ?? n.positionX ?? 0),
      y: Number(n.position_y ?? n.positionY ?? 0),
    },
    config: parseJsonObject(n.config_json ?? n.configJson),
  }));
  const edges: EdgeSpec[] = (wire.edges ?? []).map((e) => ({
    id: String(e.id ?? ''),
    source: String(e.source ?? ''),
    sourceHandle: String(e.source_handle ?? e.sourceHandle ?? ''),
    target: String(e.target ?? ''),
    targetHandle: e.target_handle ?? e.targetHandle ?? 'in',
  }));
  const viewportRaw = wire.viewport_json ?? wire.viewportJson;
  let viewport: GraphSpec['viewport'];
  if (viewportRaw) {
    const v = parseJsonObject(viewportRaw);
    if ('x' in v || 'y' in v || 'zoom' in v) {
      viewport = { x: Number(v.x ?? 0), y: Number(v.y ?? 0), zoom: Number(v.zoom ?? 1) };
    }
  }
  return { version: Number(wire.version ?? 2) || 2, nodes, edges, viewport };
}

/** Parse the stored `graph_json` string into an internal {@link GraphSpec}. */
export function graphFromJson(raw: string | undefined | null): GraphSpec | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw);
    if (v && typeof v === 'object' && Array.isArray((v as GraphSpec).nodes)) {
      return v as GraphSpec;
    }
  } catch {
    // malformed stored graph → treat as absent.
  }
  return null;
}

/** Serialize the internal {@link GraphSpec} into the storage string. */
export function graphToJson(graph: GraphSpec): string {
  return JSON.stringify(graph);
}

/**
 * Serialize the internal {@link GraphSpec} into the wire (proto) shape for GetRule
 * responses. Snake_case keys match the proto field names; with `arrays:true` on the
 * gateway loader empty `nodes`/`edges` still surface as `[]`.
 */
export function graphToWire(graph: GraphSpec): WireGraph {
  return {
    version: graph.version,
    nodes: graph.nodes.map((n) => ({
      id: n.id,
      type: n.type,
      position_x: n.position?.x ?? 0,
      position_y: n.position?.y ?? 0,
      config_json: JSON.stringify(n.config ?? {}),
    })),
    edges: graph.edges.map((e) => ({
      id: e.id,
      source: e.source,
      source_handle: e.sourceHandle,
      target: e.target,
      target_handle: e.targetHandle ?? 'in',
    })),
    viewport_json: graph.viewport ? JSON.stringify(graph.viewport) : '',
  };
}

/**
 * Denormalize the rule's flat `trigger_type`/`trigger_config_json` from the single
 * trigger node so the consumer matcher (`find({trigger_type:'event'})` +
 * `ruleMatchesEvent`) keeps working WITHOUT reading the graph (contract §1.2).
 *
 * Returns `{ trigger_type:'event', trigger_config_json:'{"event_name":...}' }`.
 */
export function denormalizeTrigger(graph: GraphSpec): {
  trigger_type: string;
  trigger_config_json: string;
} {
  const trigger = graph.nodes.find((n) => n.type === 'trigger');
  const cfg = (trigger?.config ?? {}) as Record<string, unknown>;
  const eventName = String(cfg.event_name ?? cfg.eventName ?? cfg.trigger_id ?? cfg.triggerId ?? '').trim();
  const params = (cfg.params ?? {}) as Record<string, unknown>;
  return {
    // All event-driven rules carry trigger_type='event' so the consumer query
    // `find({trigger_type:'event'})` matches v1 and v2 rules alike (§1.2).
    trigger_type: 'event',
    trigger_config_json: JSON.stringify({ event_name: eventName, ...params }),
  };
}
