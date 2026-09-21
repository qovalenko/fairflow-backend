/**
 * Node-registry catalog for the v2 canvas palette (contract §2.3 GetNodeRegistry).
 *
 * Re-projects the existing in-code TRIGGER/ACTION catalogs (registry.ts) into
 * {@link NodeTypeDef}s with derived static out-handles, plus the two structural
 * node types (condition/branch) that have no catalog entry. The module filter is
 * applied by the caller (`getNodeRegistry`) from gateway-trusted x-enabled-modules
 * — never from the client body (SEC v1 §3.12).
 */
import { ACTION_CATALOG, TRIGGER_CATALOG } from '../registry';
import type { NodeTypeDef } from './graph-types';

/** Static structural node types (no catalog entry; one type covers all). */
export const STRUCTURAL_NODE_TYPES: NodeTypeDef[] = [
  {
    type: 'condition',
    subtype: '',
    requiredModule: 'automation',
    externalEffect: false,
    entityType: '',
    // The predicate is an AbacNode (record.*/trigger.* operands, eq/ne/gt/lt/
    // gte/lte/contains/is_empty/is_not_empty + and/or/not). Schema is descriptive.
    configSchema: { predicate: 'AbacNode|null' },
    outputSchema: {},
    outHandles: ['true', 'false'],
  },
  {
    type: 'branch',
    subtype: '',
    requiredModule: 'automation',
    externalEffect: false,
    entityType: '',
    configSchema: { on: 'string', cases: 'array<{key,equals}>' },
    outputSchema: {},
    // case:<key> handles are dynamic per config.cases[].key; 'else' is implicit.
    outHandles: ['else'],
  },
];

/** Trigger catalog → NodeTypeDef[] (out-handle is always 'out'). */
export function triggerNodeTypes(): NodeTypeDef[] {
  return TRIGGER_CATALOG.map((t) => ({
    type: 'trigger' as const,
    subtype: t.id,
    requiredModule: t.requiredModule,
    externalEffect: false,
    entityType: t.entityType,
    configSchema: t.configSchema,
    outputSchema: t.outputSchema,
    outHandles: ['out'],
  }));
}

/** Action catalog → NodeTypeDef[] (out-handle is always 'out'). */
export function actionNodeTypes(): NodeTypeDef[] {
  return ACTION_CATALOG.map((a) => ({
    type: 'action' as const,
    subtype: a.id,
    requiredModule: a.requiredModule,
    externalEffect: a.externalEffect,
    entityType: '',
    configSchema: a.configSchema,
    outputSchema: {},
    outHandles: ['out'],
  }));
}
