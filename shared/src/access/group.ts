/**
 * E2-06 — Access Unit / Group model (RFC-ACCESS-GROUPS §2).
 *
 * Generalizes `Department` into one primitive `AccessGroup` with normalized
 * membership (`AccessGroupMember`), supporting:
 *  - multiple membership (a user can belong to many groups),
 *  - nested groups (`memberType='group'` — composition, a DAG),
 *  - an optional structural hierarchy (`parentId`, a tree),
 *  - an optional leader (`leaderUserId`).
 *
 * Two distinct "group → group" axes (NORMATIVE — §2.1):
 *  - `parentId`               structural hierarchy (tree, one parent, walks DOWN);
 *                             `own_subgroups` traverses ONLY this axis.
 *  - `memberType='group'`     composition ("contents", DAG); affects ONLY the
 *                             effective member set (`effectiveUsers`), never
 *                             leadership / `own_subgroups`.
 *
 * Lives entirely in control / PostgreSQL (schema "control"). CRM domains (Mongo)
 * get no new entities — records still store only ownerId/assigneeId.
 */

export type AccessGroupScopeType = 'ORGANIZATION' | 'PROJECT';
export type AccessGroupKind = 'department' | 'team' | 'territory' | 'custom';
export type AccessGroupMemberType = 'user' | 'group';

export const ACCESS_GROUP_KINDS: readonly AccessGroupKind[] = [
  'department',
  'team',
  'territory',
  'custom',
] as const;

export function isAccessGroupKind(value: unknown): value is AccessGroupKind {
  return typeof value === 'string' && (ACCESS_GROUP_KINDS as readonly string[]).includes(value);
}

export function isAccessGroupScopeType(value: unknown): value is AccessGroupScopeType {
  return value === 'ORGANIZATION' || value === 'PROJECT';
}

export function isAccessGroupMemberType(value: unknown): value is AccessGroupMemberType {
  return value === 'user' || value === 'group';
}

export interface AccessGroup {
  id: string;
  scopeType: AccessGroupScopeType; // where the group lives
  scopeId: string; // organizationId | projectId
  name: string;
  kind: AccessGroupKind;
  parentId?: string | null; // OPTIONAL hierarchy (adjacency-list, tree)
  leaderUserId?: string | null; // OPTIONAL leader
  archivedAt?: string | null; // soft-delete
}

export interface AccessGroupMember {
  groupId: string;
  memberType: AccessGroupMemberType; // 'user' | 'group' (nested groups)
  memberId: string; // userId | childGroupId
}

/**
 * Failsafe for composition / hierarchy traversal depth (RFC §6 R3 — M3.3).
 * Real depth is 2–4; this is a guard against pathological cycles/fan-out.
 */
export const MAX_GROUP_DEPTH = 20;
