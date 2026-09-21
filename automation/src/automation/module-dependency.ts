import { ACTION_CATALOG, TRIGGER_CATALOG } from './registry';
import type { GraphSpec } from './graph/graph-types';
import { graphFromJson } from './graph/graph-mapper';

function configString(node: { config?: Record<string, unknown> }, ...keys: string[]): string {
  const cfg = node.config ?? {};
  for (const k of keys) {
    const v = (cfg as Record<string, unknown>)[k];
    if (v != null && v !== '') return String(v);
  }
  return '';
}

/** Required module ids referenced by a v1 flat rule (trigger + actions). */
export function flatRuleRequiredModules(
  triggerType: string,
  triggerConfigJson: string,
  actionsJson: string,
): string[] {
  const mods = new Set<string>();
  const trigger = parseJson(triggerConfigJson);
  const triggerId =
    String(trigger.event_name ?? trigger.eventName ?? triggerType ?? '').trim() || triggerType;
  const trig = TRIGGER_CATALOG.find((t) => t.id === triggerId || t.eventName === triggerId);
  if (trig?.requiredModule) mods.add(trig.requiredModule);

  for (const raw of parseArray(actionsJson)) {
    if (!raw || typeof raw !== 'object') continue;
    const actionId = String(
      (raw as Record<string, unknown>).type ?? (raw as Record<string, unknown>).id ?? '',
    ).trim();
    const action = ACTION_CATALOG.find((a) => a.id === actionId);
    if (action?.requiredModule) mods.add(action.requiredModule);
  }
  return [...mods];
}

/** Required module ids referenced by a v2 graph rule. */
export function graphRequiredModules(graph: GraphSpec): string[] {
  const mods = new Set<string>();
  for (const n of graph.nodes ?? []) {
    if (n.type === 'trigger') {
      const triggerId = configString(n, 'trigger_id', 'triggerId', 'event_name', 'eventName');
      const trig = TRIGGER_CATALOG.find((t) => t.id === triggerId || t.eventName === triggerId);
      if (trig?.requiredModule) mods.add(trig.requiredModule);
    } else if (n.type === 'action') {
      const actionId = configString(n, 'action_id', 'actionId', 'type');
      const action = ACTION_CATALOG.find((a) => a.id === actionId);
      if (action?.requiredModule) mods.add(action.requiredModule);
    }
  }
  return [...mods];
}

/** Required modules for a persisted rule document shape. */
export function ruleDocRequiredModules(doc: {
  engine_version?: number;
  graph_json?: string;
  trigger_type?: string;
  trigger_config_json?: string;
  actions_json?: string;
}): string[] {
  if ((doc.engine_version ?? 1) === 2) {
    const graph = graphFromJson(doc.graph_json);
    if (graph) return graphRequiredModules(graph);
  }
  return flatRuleRequiredModules(
    String(doc.trigger_type ?? ''),
    String(doc.trigger_config_json ?? '{}'),
    String(doc.actions_json ?? '[]'),
  );
}

export function missingModules(required: string[], enabledModules: string[]): string[] {
  const enabled = new Set((enabledModules ?? []).map((m) => String(m).trim()).filter(Boolean));
  return required.filter((m) => !enabled.has(m));
}

function parseJson(raw: string): Record<string, unknown> {
  try {
    const v = JSON.parse(raw || '{}');
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function parseArray(raw: string): unknown[] {
  try {
    const v = JSON.parse(raw || '[]');
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}
