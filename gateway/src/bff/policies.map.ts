/**
 * ABAC policy mapping + validation for the project-settings policy editor
 * (SCR-PRJSET-POLICIES, E2-15). The frontend speaks a flat, editor-friendly rule
 * shape (`AbacFeRule`: subject/action/effect + an AND-list of `{attribute,operator,value}`
 * conditions); the control domain stores the canonical `ProjectModulePolicyRule`
 * with a single storage-neutral predicate tree (`AbacNode`, RFC-ABAC §1.1) in its
 * `condition`. This module is the bidirectional adapter + the save-time validator.
 *
 * Validation depth (intentional, honest ceiling):
 *   - module/subject/action against the manifest-derived permission catalog
 *     (mirrors control's `validatePolicyRules`, so the gateway's `accepted` set
 *     matches what control will actually persist — no silent drops on save);
 *   - condition SYNTAX via `parseAbac` (closed operator/namespace set, operand
 *     form, nested-path/field-vs-field/malformed) → canonical `AbacErrorCode`.
 * Full semantic validation (`validateAbac`) is deliberately NOT run: it requires a
 * per-subject `record.*` operand catalog (`AbacOperandDescriptor[]`) that the
 * current `MODULE_REGISTRY` does not carry, so it would reject every `record.*`
 * ref. Type/per-field-operator checks therefore surface at eval time, not here.
 */
import { randomUUID } from 'node:crypto';
import {
  AbacError,
  AbacNode,
  getRegistryPermissionCatalog,
  isWithinNamespace,
  MODULE_REGISTRY,
  normalizeAction,
  parseAbac,
  parsePermissionKey,
} from '@fairflow/shared';

/** Closed leaf-operator set the flat editor can express (RFC-ABAC §1.1, sans and/or/not). */
const LEAF_OPS = new Set(['eq', 'ne', 'gt', 'gte', 'lt', 'lte', 'in', 'nin']);

/**
 * Unconditional module-policy deny on these subjects strips project ownership
 * at the gateway overlay (`isDeniedByPolicy`) — hard reject on save (FR-ABAC-24).
 * Mirrors `RolesService.DENY_FORBIDDEN_SUBJECTS` + `access`.
 */
export const OWNER_LOCKOUT_SUBJECTS = new Set(['roles', 'project', 'members', 'access']);

export type AbacLeafOp = 'eq' | 'ne' | 'gt' | 'gte' | 'lt' | 'lte' | 'in' | 'nin';
export type AbacFeLiteral = string | number | boolean | null | Array<string | number | boolean>;

export type AbacFeCondition = {
  attribute: string; // 'record.<flat>' | 'user.<attr>' | 'project.<attr>'
  operator: AbacLeafOp;
  value: AbacFeLiteral;
};

export type AbacFeRule = {
  id?: string;
  subject: string;
  action: string;
  effect: 'allow' | 'deny';
  conditions: AbacFeCondition[];
  inactive?: boolean;
  moduleId?: string;
};

/** Control's gRPC `ModulePolicyRule` shape (keepCase:true → snake_case, condition = Struct→object). */
export type GrpcPolicyRule = {
  id?: string;
  module_id?: string;
  effect?: string;
  subject?: string;
  action?: string;
  resource?: string;
  condition?: Record<string, unknown>;
};

export type PolicyRejection = { index: number; code: string; message?: string; path?: string };

export type PolicyEvaluation = {
  /** Echo of the input rules that passed (moduleId resolved) — FE `PolicySaveResult.accepted`. */
  accepted: AbacFeRule[];
  /** Canonical rules to persist via `ProjectGrpc.UpdateProject` (replaces module_policies). */
  acceptedGrpc: GrpcPolicyRule[];
  rejected: PolicyRejection[];
  /** Anti-lockout hint (FR-ABAC-24): an unconditional deny can block even the owner. */
  selfLockoutWarning: boolean;
};

/** Resolve the owning module of a subject from its manifest namespace (exact, then prefix). */
export function moduleIdForSubject(subject: string): string {
  for (const [id, def] of Object.entries(MODULE_REGISTRY)) {
    if (def.policyCapabilities.some((cap) => cap.subject === subject)) return id;
  }
  for (const id of Object.keys(MODULE_REGISTRY)) {
    if (subject === id || subject.startsWith(`${id}.`)) return id;
  }
  return '';
}

/** A single flat condition → an ABAC leaf node (JSON; validated later by `parseAbac`). */
function conditionToLeaf(c: AbacFeCondition): Record<string, unknown> {
  return { op: c.operator, left: { ref: c.attribute }, right: { lit: c.value } };
}

/**
 * FE AND-list → stored `condition` JSON. 0 → `{}` (unconditional, control's canonical
 * "no gate"); 1 → the leaf; N → `{op:'and', nodes:[...]}`.
 */
export function conditionsToNode(conds: AbacFeCondition[]): Record<string, unknown> {
  if (conds.length === 0) return {};
  if (conds.length === 1) return conditionToLeaf(conds[0]);
  return { op: 'and', nodes: conds.map(conditionToLeaf) };
}

/**
 * Stored `condition` (AbacNode JSON) → FE AND-list. Best-effort: a leaf or an
 * `and` of leaves flattens cleanly; an empty/missing condition is unconditional
 * (`[]`); `or`/`not`/nested shapes the flat editor cannot represent degrade to `[]`
 * (the rule still renders, just without editable conditions).
 */
export function nodeToConditions(
  condition: Record<string, unknown> | undefined,
): AbacFeCondition[] {
  if (!condition || typeof condition !== 'object' || !('op' in condition)) return [];
  let node: AbacNode;
  try {
    node = parseAbac(condition);
  } catch {
    return [];
  }
  const out: AbacFeCondition[] = [];
  const visit = (n: AbacNode): boolean => {
    if (n.op === 'and') return n.nodes.every(visit);
    if (n.op === 'or' || n.op === 'not') return false;
    // leaf: { op, left:{ref}, right:{lit} }
    if (!('left' in n) || !('ref' in n.left) || !('lit' in n.right)) return false;
    out.push({
      attribute: n.left.ref,
      operator: n.op as AbacLeafOp,
      value: n.right.lit as AbacFeLiteral,
    });
    return true;
  };
  return visit(node) ? out : [];
}

/** Control's gRPC rule → FE rule. `inactive` = rule's module is not effectively enabled (FR-ABAC-11). */
export function grpcRuleToFe(rule: GrpcPolicyRule, effectiveModules: string[]): AbacFeRule {
  const moduleId = rule.module_id ?? '';
  return {
    id: rule.id,
    subject: rule.subject ?? '',
    action: rule.action ?? '',
    effect: rule.effect === 'deny' ? 'deny' : 'allow',
    conditions: nodeToConditions(rule.condition),
    moduleId,
    inactive: moduleId ? !effectiveModules.includes(moduleId) : false,
  };
}

/** Per-rule classification: resolved moduleId + a rejection (or null when the rule is valid). */
function classify(rule: AbacFeRule): {
  moduleId: string;
  rejection: Omit<PolicyRejection, 'index'> | null;
} {
  const moduleId =
    rule.moduleId && rule.moduleId in MODULE_REGISTRY
      ? rule.moduleId
      : moduleIdForSubject(rule.subject);

  // module/subject/action against the manifest catalog (mirrors validatePolicyRules).
  const catalog = getRegistryPermissionCatalog();
  if (
    !(moduleId in MODULE_REGISTRY) ||
    !isWithinNamespace(rule.subject, moduleId) ||
    !catalog.has(rule.subject, normalizeAction(rule.action))
  ) {
    return {
      moduleId,
      rejection: {
        code: 'MALFORMED_NODE',
        message: `subject:action "${rule.subject}:${rule.action}" is not in the project permission catalog`,
        path: '$.subject',
      },
    };
  }

  // condition syntax (skip for unconditional rules — `{}` is canonical "no gate").
  if (rule.conditions.length > 0) {
    // structural guard on operators before parse so we emit the precise FE code.
    for (let i = 0; i < rule.conditions.length; i++) {
      if (!LEAF_OPS.has(rule.conditions[i].operator)) {
        return {
          moduleId,
          rejection: {
            code: 'OPERATOR_NOT_SUPPORTED',
            message: `operator not supported: "${rule.conditions[i].operator}"`,
            path: `$.conditions[${i}].operator`,
          },
        };
      }
    }
    try {
      parseAbac(conditionsToNode(rule.conditions));
    } catch (e) {
      if (e instanceof AbacError) {
        return { moduleId, rejection: { code: e.code, message: e.message, path: e.path } };
      }
      return {
        moduleId,
        rejection: { code: 'MALFORMED_NODE', message: String((e as Error)?.message ?? e) },
      };
    }
  }

  return { moduleId, rejection: null };
}

/**
 * Validate + adapt a full FE rule set. Pure (no IO): used by both the dry-run
 * `validate` endpoint and the `save` endpoint (which then persists `acceptedGrpc`).
 */
export function evaluatePolicies(rules: AbacFeRule[]): PolicyEvaluation {
  const accepted: AbacFeRule[] = [];
  const acceptedGrpc: GrpcPolicyRule[] = [];
  const rejected: PolicyRejection[] = [];

  rules.forEach((rule, index) => {
    const { moduleId, rejection } = classify(rule);
    if (rejection) {
      rejected.push({ index, ...rejection });
      return;
    }
    accepted.push({ ...rule, moduleId });
    acceptedGrpc.push({
      id: rule.id && rule.id.length > 0 ? rule.id : randomUUID(),
      module_id: moduleId,
      effect: rule.effect === 'deny' ? 'deny' : 'allow',
      subject: rule.subject,
      action: rule.action,
      resource: '*',
      condition: conditionsToNode(rule.conditions),
    });
  });

  const lockout = assessPolicyLockout(accepted);

  return {
    accepted,
    acceptedGrpc,
    rejected,
    selfLockoutWarning: lockout.selfLockoutWarning,
  };
}

/** Unconditional deny (no ABAC gate) — the shape the gateway overlay enforces. */
export function isBlanketDenyRule(rule: AbacFeRule): boolean {
  return rule.effect === 'deny' && rule.conditions.length === 0;
}

/** Whether a blanket deny blocks a catalog `subject:action` key held by the actor. */
export function blanketDenyBlocksKey(rule: AbacFeRule, permissionKey: string): boolean {
  if (!isBlanketDenyRule(rule)) return false;
  const parsed = parsePermissionKey(permissionKey);
  if (!parsed) return false;
  if (rule.subject !== parsed.subject) return false;
  const deniedAction = normalizeAction(rule.action);
  const heldAction = normalizeAction(parsed.action);
  return deniedAction === '*' || deniedAction === heldAction;
}

/**
 * Anti-lockout assessment for accepted rules (FR-ABAC-24 / FR-ACCESS-485).
 * Owner: unconditional deny on access-control subjects → hard reject on save.
 * Author: unconditional deny overlapping the actor's effective allow → warn.
 */
export function assessPolicyLockout(
  accepted: AbacFeRule[],
  authorAllowKeys: string[] = [],
): { ownerLockout: boolean; selfLockoutWarning: boolean } {
  const blanketDenies = accepted.filter(isBlanketDenyRule);
  const ownerLockout = blanketDenies.some((r) => OWNER_LOCKOUT_SUBJECTS.has(r.subject));
  const selfLockoutWarning =
    authorAllowKeys.length > 0 &&
    authorAllowKeys.some((key) => blanketDenies.some((r) => blanketDenyBlocksKey(r, key)));
  return { ownerLockout, selfLockoutWarning };
}

/** Pre-catalog guard: blanket deny on access-control subjects (FR-ACCESS-485). */
export function hasOwnerLockoutRisk(rules: AbacFeRule[]): boolean {
  return rules.some((r) => isBlanketDenyRule(r) && OWNER_LOCKOUT_SUBJECTS.has(r.subject));
}
