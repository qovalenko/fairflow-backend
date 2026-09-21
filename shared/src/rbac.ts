/**
 * RBAC: role → action matrix (business-process spec §12–13).
 *
 * Two role axes:
 *  - Project roles  (per ProjectMember) gate CRM data actions inside a project.
 *  - Org roles      (per Employee)      gate org-level actions (profile, structure, licenses).
 *
 * The matrix here is role × action (subject-independent). Subject-level
 * granularity (per-record visibility, allow/deny policy rules) is a later layer
 * — see modulePolicies / record-visibility epics.
 */

export const PROJECT_ROLES = ['owner', 'admin', 'manager', 'member', 'viewer'] as const;
export type ProjectRole = (typeof PROJECT_ROLES)[number];

export const ORG_ROLES = ['platform_owner', 'platform_admin', 'employee'] as const;
export type OrgRole = (typeof ORG_ROLES)[number];

/** Action vocabulary, taken from module-registry policy capabilities. */
export type PermissionAction =
  | 'read'
  | 'write'
  | 'delete'
  | 'manage'
  | 'move'
  | 'export'
  // bulk record import — a mass mutation, gated separately from `write`
  // (elevated: never granted to member/viewer). NOT a `write` synonym.
  | 'import'
  | 'execute'
  | 'invoke'
  // chat (M-CHAT-11 / FR-CHAT-49): edit/delete OTHER users' messages (moderation
  // by a department head). `write` stays self-scoped to one's own messages.
  | 'moderate';

/**
 * CANON (decision Р-6 / X-6, P8): this 10-action dictionary is the canonical action
 * vocabulary. Special verbs (`generate`/`reassign`/`simulate` and the like) are NOT
 * added here — they are permitted only via an explicit allow-list in a module's
 * catalog, never by widening this core set.
 */
const ALL_ACTIONS: PermissionAction[] = [
  'read',
  'write',
  'delete',
  'manage',
  'move',
  'export',
  'import',
  'execute',
  'invoke',
  'moderate',
];

/**
 * What each project role may do. Tuned to spec §12.3:
 *  - owner/admin: full access
 *  - manager: full data ops (incl. integrations), documents template manage via
 *    granular allow-list; documents delete denied via deny-list (FR-DOCS-215)
 *  - member: work with data (read/write, move stages, export), no delete
 *  - viewer: read-only
 */
const PROJECT_ROLE_ACTIONS: Record<ProjectRole, ReadonlySet<PermissionAction>> = {
  owner: new Set(ALL_ACTIONS),
  admin: new Set(ALL_ACTIONS),
  manager: new Set<PermissionAction>([
    'read',
    'write',
    'delete',
    'move',
    'export',
    // bulk import is elevated (mass mutation) — manager+ only, never member/viewer.
    'import',
    'execute',
    'invoke',
    // chat moderation (FR-CHAT-49): a manager (department head) may edit/delete
    // other members' messages within their scope.
    'moderate',
  ]),
  member: new Set<PermissionAction>(['read', 'write', 'move', 'export']),
  viewer: new Set<PermissionAction>(['read']),
};

/**
 * Granular per-role `subject:action` allow-list ON TOP of the flat role×action
 * matrix (owner decision 2026-08-16: a member MUST be able to generate
 * documents). The flat matrix cannot express "member may `execute` document
 * generation but not `execute` anything else" — adding `execute` to the
 * member's action set would silently widen EVERY `*:execute` catalog key
 * (`automation:execute`, `companies:execute`, …). This list grants exactly the
 * named catalog keys and nothing else.
 *
 * Contract:
 *  - keys are canonical catalog keys (`subject:action`, RFC-1 vocabulary);
 *  - consumed by BOTH enforcement paths in lock-step: the gateway PEP flat
 *    check (`projectRoleCanKey`) and the system-role data expansion
 *    (`expandSystemRolePermissions`, permission-rbac.ts) — extend it here and
 *    both paths pick the grant up;
 *  - it can only ADD keys for a role, never remove; deny-invariants
 *    (§7.6, `isProjectGrantablePermission`) still apply downstream.
 */
export const PROJECT_ROLE_KEY_ALLOWLIST: Partial<
  Record<ProjectRole, ReadonlySet<string>>
> = {
  // Member generates documents (owner decision 2026-08-16, FR-DOCS/TODO-045):
  // exactly the key the generate/regenerate routes and the FE button gate on.
  member: new Set<string>(['documents.generate:execute']),
  // FR-DOCS-212 / TZ §8.1: manager+ may CRUD/lifecycle project templates without
  // gaining `manage` on every other subject (project settings stay admin+).
  manager: new Set<string>(['documents:manage']),
};

/**
 * Subject-aware DENY overlay on top of the flat role×action matrix. Checked BEFORE
 * the matrix and the allow-list so a role can hold `delete` globally yet lose a
 * specific catalog key (FR-DOCS-215: documents soft-delete = admin+ only).
 */
export const PROJECT_ROLE_KEY_DENYLIST: Partial<
  Record<ProjectRole, ReadonlySet<string>>
> = {
  // FR-PRODUCTS-250: write=manager+, delete=admin+ (product.md §RBAC).
  member: new Set<string>(['products:write']),
  // FR-DOCS-215 + FR-PRODUCTS-250 + FR-ACCESS-145 / §7.6.2: manager holds `delete`
  // on CRM data but NOT on documents/project entities — routes are gated separately,
  // but the compiled RolePermission projection must not emit those keys.
  manager: new Set<string>(['documents:delete', 'products:delete', 'project:delete']),
};

export function isProjectRole(value: unknown): value is ProjectRole {
  return typeof value === 'string' && (PROJECT_ROLES as readonly string[]).includes(value);
}

export function isOrgRole(value: unknown): value is OrgRole {
  return typeof value === 'string' && (ORG_ROLES as readonly string[]).includes(value);
}

/** True if `role` is permitted to perform `action` on CRM data within a project. */
export function projectRoleCan(
  role: string | undefined | null,
  action: PermissionAction,
): boolean {
  if (!role) return false;
  const allowed = PROJECT_ROLE_ACTIONS[role as ProjectRole];
  return allowed ? allowed.has(action) : false;
}

/**
 * Subject-aware role check: the flat matrix (`projectRoleCan`) OR the granular
 * per-role key allow-list. This is what the gateway PEP uses for
 * `@RequirePermission(subject, action)` routes, so a granular grant
 * (e.g. member + `documents.generate:execute`) passes WITHOUT the role gaining
 * the action on any other subject. Fail-closed: unknown role / no allow-list
 * entry → matrix answer only.
 */
export function projectRoleCanKey(
  role: string | undefined | null,
  subject: string,
  action: PermissionAction,
): boolean {
  const key = `${subject}:${action}`;
  if (role && isProjectRole(role)) {
    const deny = PROJECT_ROLE_KEY_DENYLIST[role];
    if (deny?.has(key)) return false;
  }
  if (projectRoleCan(role, action)) return true;
  if (!role || !isProjectRole(role) || !subject) return false;
  const extra = PROJECT_ROLE_KEY_ALLOWLIST[role];
  return extra ? extra.has(key) : false;
}

/** Org-level admin actions (profile/structure/licenses) require owner or admin. */
export function orgRoleCanManage(role: string | undefined | null): boolean {
  return role === 'platform_owner' || role === 'platform_admin';
}

/** Rank for "at least this role" comparisons (higher = more privileged). */
const PROJECT_ROLE_RANK: Record<ProjectRole, number> = {
  viewer: 1,
  member: 2,
  manager: 3,
  admin: 4,
  owner: 5,
};

export function projectRoleAtLeast(
  role: string | undefined | null,
  min: ProjectRole,
): boolean {
  if (!isProjectRole(role)) return false;
  return PROJECT_ROLE_RANK[role] >= PROJECT_ROLE_RANK[min];
}

/* ────────────────────────────────────────────────────────────────────────
 * Record visibility (business-process spec §13.2/§13.4) — phase 4d.
 *
 * Orthogonal to the role→action matrix above: RBAC decides *whether* a role may
 * read a resource type at all; visibility decides *which records* of that type a
 * member sees. A record is always owned by a person (ownerId/assigneeId);
 * department scope is derived from the owner's department, sharing is explicit.
 * ──────────────────────────────────────────────────────────────────────── */

export const VISIBILITY_LEVELS = [
  'only_own', // только свои
  'own_and_shared', // свои + расшаренные (дефолт для member)
  'own_and_subordinates', // свои + подчинённых (по руководству отделами)
  'own_and_department', // свои + своего отдела (+ под-отделов)
  'all', // все записи проекта
] as const;
export type VisibilityLevel = (typeof VISIBILITY_LEVELS)[number];

export function isVisibilityLevel(value: unknown): value is VisibilityLevel {
  return typeof value === 'string' && (VISIBILITY_LEVELS as readonly string[]).includes(value);
}

/** Per-role defaults from spec §13.4 (manager+ see everything; member sees own+shared). */
export const DEFAULT_VISIBILITY_BY_ROLE: Record<ProjectRole, VisibilityLevel> = {
  owner: 'all',
  admin: 'all',
  manager: 'all',
  member: 'own_and_shared',
  viewer: 'own_and_shared',
};

/** Rank for visibility-level comparisons (higher = wider scope). FR-ACCESS-315 / FR-PERM-floor. */
export const VISIBILITY_LEVEL_RANK: Record<VisibilityLevel, number> = {
  only_own: 1,
  own_and_shared: 2,
  own_and_subordinates: 3,
  own_and_department: 4,
  all: 5,
};

/**
 * RBAC floor: the widest legacy visibility level a role may receive via
 * `Project.visibilityConfig` (FR-ACCESS-315, permission-rbac FR-PERM-floor).
 * `member`/`viewer` never get `all`; admin+ may.
 */
export const MAX_VISIBILITY_BY_ROLE: Record<ProjectRole, VisibilityLevel> = {
  owner: 'all',
  admin: 'all',
  manager: 'all',
  member: 'own_and_department',
  viewer: 'own_and_department',
};

/** Clamp a legacy level to the RBAC floor of `role`. */
export function clampVisibilityLevel(role: ProjectRole, level: VisibilityLevel): VisibilityLevel {
  const max = MAX_VISIBILITY_BY_ROLE[role];
  return VISIBILITY_LEVEL_RANK[level] > VISIBILITY_LEVEL_RANK[max] ? max : level;
}

/** True when a policy carries an absorbing `all` rule. */
export function visibilityPolicyHasAll(policy: VisibilityPolicy): boolean {
  return policy.rules.some((r) => r.kind === 'all');
}

/** Clamp a v2 policy so it does not exceed the role RBAC floor (strips `all` when forbidden). */
export function clampVisibilityPolicy(role: ProjectRole, policy: VisibilityPolicy): VisibilityPolicy {
  if (MAX_VISIBILITY_BY_ROLE[role] === 'all' || !visibilityPolicyHasAll(policy)) return policy;
  const maxPolicy = legacyLevelToPolicy(MAX_VISIBILITY_BY_ROLE[role]);
  const rules = policy.rules.filter((r) => r.kind !== 'all');
  return rules.length > 0 ? { rules } : maxPolicy;
}

export type ProjectVisibilityConfig = Partial<Record<ProjectRole, VisibilityLevel>>;

/** Validate a raw per-project visibility config (role → level); drops bad entries. */
export function normalizeVisibilityConfig(raw: unknown): ProjectVisibilityConfig {
  const out: ProjectVisibilityConfig = {};
  if (!raw || typeof raw !== 'object') return out;
  for (const [role, level] of Object.entries(raw as Record<string, unknown>)) {
    if (isProjectRole(role) && isVisibilityLevel(level)) {
      out[role] = clampVisibilityLevel(role, level);
    }
  }
  return out;
}

/** Effective level for a role: per-project override → spec default → safest (only_own). */
export function effectiveVisibilityLevel(
  role: string | undefined | null,
  config?: ProjectVisibilityConfig | null,
): VisibilityLevel {
  if (!isProjectRole(role)) return 'only_own';
  const entry = config?.[role];
  const raw =
    typeof entry === 'string' && isVisibilityLevel(entry)
      ? entry
      : (DEFAULT_VISIBILITY_BY_ROLE[role] ?? 'only_own');
  return clampVisibilityLevel(role, raw);
}

/* ────────────────────────────────────────────────────────────────────────
 * E2-07 — Configurable visibility policy (RFC-ACCESS-GROUPS §3.4).
 *
 * The hard `VisibilityLevel` enum becomes a configurable union of primitives.
 * The legacy 5-value enum is a special case mapped 1:1 to a policy (B1: the
 * `roots` parameter on `own_subgroups` keeps the mapping strictly 1:1, since
 * `own_and_subordinates` (roots='led') and `own_and_department` (roots='member')
 * produce *different* ownerIds[] from different subtree roots).
 *
 * `own_subgroups` walks ONLY the parentId hierarchy (never composition).
 * `own_groups`/`selected_groups` expand `effectiveUsers` (composition DAG).
 * The resolver (control) turns a policy into the same flat ownerIds[] —
 * `buildVisibilityFilter`, `serializeVisibilityScope`, the `x-visibility-scope`
 * contract and the CRM domains are NOT touched.
 * ──────────────────────────────────────────────────────────────────────── */

export type VisibilityRuleKind =
  | 'own'
  | 'own_groups'
  | 'own_subgroups'
  | 'selected_groups'
  | 'all';

export type VisibilityRule =
  | { kind: 'own' }
  | { kind: 'own_groups' }
  | { kind: 'own_subgroups'; roots: 'led' | 'member' } // B1: explicit subtree-root source
  | { kind: 'selected_groups'; groupIds: string[] }
  | { kind: 'all' };

/** A role's visibility = the union of its rules (`all` is absorbing). */
export interface VisibilityPolicy {
  rules: VisibilityRule[];
}

/** A per-project config value may be a legacy level string or a full policy object. */
export type VisibilityConfigEntry = VisibilityLevel | VisibilityPolicy;
export type ProjectVisibilityConfigV2 = Partial<Record<ProjectRole, VisibilityConfigEntry>>;

/** Map a legacy `VisibilityLevel` → its 1:1 `VisibilityPolicy` (RFC §4). */
export function legacyLevelToPolicy(level: VisibilityLevel): VisibilityPolicy {
  switch (level) {
    case 'only_own':
      return { rules: [{ kind: 'own' }] };
    case 'own_and_shared':
      // shares are additive for every restricted level except only_own (resolver-side).
      return { rules: [{ kind: 'own' }] };
    case 'own_and_subordinates':
      return { rules: [{ kind: 'own' }, { kind: 'own_subgroups', roots: 'led' }] };
    case 'own_and_department':
      return { rules: [{ kind: 'own' }, { kind: 'own_subgroups', roots: 'member' }] };
    case 'all':
      return { rules: [{ kind: 'all' }] };
    default:
      return { rules: [{ kind: 'own' }] };
  }
}

export function isVisibilityRule(value: unknown): value is VisibilityRule {
  if (!value || typeof value !== 'object') return false;
  const r = value as { kind?: unknown; roots?: unknown; groupIds?: unknown };
  switch (r.kind) {
    case 'own':
    case 'own_groups':
    case 'all':
      return true;
    case 'own_subgroups':
      return r.roots === 'led' || r.roots === 'member';
    case 'selected_groups':
      return Array.isArray(r.groupIds) && r.groupIds.every((x) => typeof x === 'string');
    default:
      return false;
  }
}

/** Validate a raw policy object (`{ rules: [...] }`); drops bad rules. Returns null if unusable. */
export function normalizeVisibilityPolicy(raw: unknown): VisibilityPolicy | null {
  if (!raw || typeof raw !== 'object') return null;
  const rules = (raw as { rules?: unknown }).rules;
  if (!Array.isArray(rules)) return null;
  const out: VisibilityRule[] = [];
  for (const r of rules) {
    if (isVisibilityRule(r)) out.push(r as VisibilityRule);
  }
  // A policy with no valid rules is meaningless → caller falls back to default.
  return out.length ? { rules: out } : null;
}

/**
 * Validate a raw v2 per-project config — each entry is a legacy level string OR
 * a `VisibilityPolicy` object. Drops bad entries (fail-closed: unknown → omitted,
 * resolver then uses the per-role default). Backward compatible with the v1
 * (string-only) shape.
 */
export function normalizeVisibilityConfigV2(raw: unknown): ProjectVisibilityConfigV2 {
  const out: ProjectVisibilityConfigV2 = {};
  if (!raw || typeof raw !== 'object') return out;
  for (const [role, entry] of Object.entries(raw as Record<string, unknown>)) {
    if (!isProjectRole(role)) continue;
    if (isVisibilityLevel(entry)) {
      out[role] = clampVisibilityLevel(role, entry);
    } else {
      const policy = normalizeVisibilityPolicy(entry);
      if (policy) out[role] = clampVisibilityPolicy(role, policy);
    }
  }
  return out;
}

/**
 * Effective `VisibilityPolicy` for a role: per-project override (legacy string →
 * 1:1 mapping; policy object → as-is) → per-role default level → safest.
 */
export function effectiveVisibilityPolicy(
  role: string | undefined | null,
  config?: ProjectVisibilityConfigV2 | null,
): VisibilityPolicy {
  if (!isProjectRole(role)) return { rules: [{ kind: 'own' }] };
  const entry = config?.[role];
  if (typeof entry === 'string') {
    return legacyLevelToPolicy(clampVisibilityLevel(role, entry));
  }
  if (entry && typeof entry === 'object' && Array.isArray(entry.rules)) {
    const normalized = normalizeVisibilityPolicy(entry);
    if (normalized) return clampVisibilityPolicy(role, normalized);
  }
  return legacyLevelToPolicy(clampVisibilityLevel(role, DEFAULT_VISIBILITY_BY_ROLE[role] ?? 'only_own'));
}

/**
 * True when a role's config (legacy string) requests additive sharing. For a
 * policy object, sharing is on for any restricted policy that is not a single
 * bare `own` rule (mirrors the legacy only_own-vs-rest behaviour).
 */
export function visibilityPolicyUsesSharing(
  role: string | undefined | null,
  config?: ProjectVisibilityConfigV2 | null,
): boolean {
  if (!isProjectRole(role)) return false;
  const entry = config?.[role];
  if (typeof entry === 'string') return entry !== 'only_own';
  // default path
  if (entry == null) {
    return (DEFAULT_VISIBILITY_BY_ROLE[role] ?? 'only_own') !== 'only_own';
  }
  // policy object: sharing off only when the sole rule is bare `own`.
  const policy = normalizeVisibilityPolicy(entry) ?? { rules: [{ kind: 'own' as const }] };
  if (policy.rules.length === 1 && policy.rules[0]!.kind === 'own') return false;
  return true;
}

/**
 * Resolved, per-request visibility scope. Built by the gateway (it alone can
 * reach the org structure in control) and propagated to CRM domains via the
 * `x-visibility-scope` metadata header. Domains turn it into a Mongo filter.
 *
 *  - mode 'all'        → no record-level filtering (manager+, personal projects).
 *  - mode 'restricted' → record visible iff its owner ∈ ownerIds, OR it is shared
 *                        with the viewer (user share) or with one of departmentIds.
 */
/* ────────────────────────────────────────────────────────────────────────
 * [#19] Scope-size cap + compact descriptor (metadata-budget hardening).
 *
 * The resolved scope travels as ONE base64(JSON) `x-visibility-scope` gRPC
 * metadata value. gRPC's default per-message metadata budget is ~8 KiB, so a
 * fully expanded `ownerIds[]` (+ `sharedRecordIds[]`) for a large org (hundreds
 * of employees / thousands of shares) would blow the budget → hard request
 * failure. And a `$in:[...thousands...]` Mongo predicate degrades badly.
 *
 * Fix (two parts):
 *  (a) A hard cap on the total number of expanded ids we are willing to inline.
 *      When exceeded, control does NOT inline the lists — it flips the scope to
 *      `deferred` mode carrying a COMPACT `descriptor` (viewer's units + rule
 *      kinds + sharing flag) instead. The metadata then stays O(#unitsOfUser),
 *      independent of org size.
 *  (b) The domain, on seeing `deferred`, resolves the flat lists itself
 *      (server-side) from the descriptor, keyed by (projectId,userId,resource,
 *      epoch) with an epoch-keyed cache. `buildVisibilityFilter` is fail-closed
 *      for a deferred scope that has NOT been resolved (deny-all), so a domain
 *      that has not yet implemented the resolver reveals NOTHING rather than
 *      leaking on a truncated/empty list.
 *
 * [#19] The server-side descriptor resolver is `VisibilityScopeHydrationGuard`
 * (grpc/visibility-hydration.ts): it sees a `deferred` scope, re-asks control via
 * `ProjectGrpc.ResolveRecordVisibility(inline:true)` keyed by
 * (projectId,userId,resource,epoch), then `hydrateVisibilityScope`s the flat
 * lists back into `x-visibility-scope` BEFORE the handler runs — so
 * `readVisibilityScope`/`buildVisibilityFilter` need no per-domain change.
 * `contact` is the reference wiring; TODO(#19-domain roll-out): company, pipe,
 * orders, activity, product, search, documents, reports follow the same shape
 * (Этап 3). Until a domain wires the guard, deferred requests stay fail-closed
 * (deny-all) — safe, not silent-widening.
 * ──────────────────────────────────────────────────────────────────────── */

/**
 * Max number of expanded ids (ownerIds + sharedRecordIds) control will inline
 * into `x-visibility-scope`. Above this the scope switches to `deferred` +
 * descriptor. Chosen conservatively: ~2000 ids * ~26 chars (ObjectId/uuid) +
 * JSON/base64 overhead stays well under the ~8 KiB gRPC metadata budget.
 */
export const VISIBILITY_SCOPE_MAX_IDS = 2000;

/**
 * CRM resources that support per-record sharing. This IS the `RecordShare.resource`
 * vocabulary (control) and, identically, the `@RequirePermission` subject of those
 * routes — the gateway resolves a scope per resource, so the two must not drift.
 * Single source of truth for both the gateway PEP and any cross-resource consumer.
 */
export const SHAREABLE_RESOURCES = [
  'contacts',
  'companies',
  'deals',
  'orders',
  'activities',
] as const;
export type ShareableResource = (typeof SHAREABLE_RESOURCES)[number];

/**
 * [TODO-109] Shareable resource → the canonical SINGULAR entity type used by
 * cross-entity stores (the search index `entityType`). Cross-resource scopes are
 * keyed by this value so a consumer needs no plural/singular mapping of its own.
 */
export const SHAREABLE_RESOURCE_ENTITY_TYPES: Record<ShareableResource, string> = {
  contacts: 'contact',
  companies: 'company',
  deals: 'deal',
  orders: 'order',
  activities: 'activity',
};

/**
 * Every ABAC data-subject a CROSS-ENTITY store may index, mapped to the canonical
 * SINGULAR entity type it is stored under (the search index `entityType`).
 *
 * Superset of `SHAREABLE_RESOURCE_ENTITY_TYPES` — `products` is indexable but has
 * no per-record sharing, so the two maps answer different questions and only the
 * shareable subset must agree (pinned by a spec).
 *
 * WHY IT IS SHARED (review round 1, PEP↔index coupling): the gateway compiles the
 * ABAC predicate for a cross-entity route PER DATA-SUBJECT and emits one
 * `entityType`-keyed disjunct per subject in this map; the store ANDs that
 * predicate into its read filter. A type the store indexes but this map omits
 * would therefore match NO disjunct and silently vanish from results, while a
 * type present here but not indexed is merely a dead branch. Both the gateway PEP
 * and the search index derive their type vocabulary from this one constant so the
 * dangerous direction cannot happen.
 */
export const CROSS_ENTITY_SUBJECT_ENTITY_TYPES: Readonly<Record<string, string>> = {
  contacts: 'contact',
  companies: 'company',
  deals: 'deal',
  orders: 'order',
  products: 'product',
  activities: 'activity',
};

/** Inverse of `CROSS_ENTITY_SUBJECT_ENTITY_TYPES`: entity type → ABAC data-subject
 * (which is also the module id and the ABAC manifest resource for these six). */
export const CROSS_ENTITY_TYPE_SUBJECTS: Readonly<Record<string, string>> =
  Object.fromEntries(
    Object.entries(CROSS_ENTITY_SUBJECT_ENTITY_TYPES).map(([subject, type]) => [type, subject]),
  );

/**
 * Compact seed description of a restricted scope (the inputs, not the expanded
 * ownerIds[]). Size is O(#viewer units), independent of org size. The domain
 * resolves it back into flat lists server-side (see TODO(#19-domain)).
 */
export interface VisibilityScopeDescriptor {
  /** Viewer's direct unit ids (composition seeds for own_groups). */
  unitIds: string[];
  /** Units the viewer leads (own_subgroups roots='led' subtree roots). */
  ledUnitIds: string[];
  /** Explicit groups from `selected_groups` rules. */
  selectedGroupIds: string[];
  /** The policy rule kinds in effect (own|own_groups|own_subgroups|selected_groups|all). */
  ruleKinds: VisibilityRuleKind[];
  /** Whether additive record-sharing applies to this scope. */
  usesSharing: boolean;
  /** Org boundary — the domain resolver AND-s this into its cross-scope guard. */
  orgId: string;
}

export interface VisibilityScope {
  mode: 'all' | 'restricted';
  /**
   * Legacy tag for diagnostics only — `'custom'` for a policy with no legacy
   * equivalent. Domains MUST NOT interpret `level`; they read `mode`+`ownerIds`
   * (RFC-ACCESS-GROUPS ОВ-6).
   */
  level: VisibilityLevel | 'custom';
  /** Viewer's own user id. */
  selfId: string;
  /** Owner user ids the viewer may see (always includes selfId when restricted). */
  ownerIds: string[];
  /**
   * Record ids of the *current resource* explicitly shared with the viewer
   * (via a direct user grant or one of their department grants). Resolved by
   * control (which owns the RecordShare table) for the route's resource.
   */
  sharedRecordIds: string[];
  /**
   * [TODO-109] Cross-resource routes (global search) read ACROSS several shareable
   * resources in ONE call, so a single `sharedRecordIds` list — which is always
   * resolved for exactly one `resource` — cannot express their shares. For those
   * routes the gateway resolves the shares of every shareable resource and stamps
   * them here, keyed by the CANONICAL SINGULAR ENTITY TYPE
   * (`SHAREABLE_RESOURCE_ENTITY_TYPES`, e.g. `contacts` → `contact`), because a
   * cross-entity index identifies a record by `(entityType, entityId)` and NOT by
   * its own document id. Single-resource routes keep using `sharedRecordIds` and
   * never see this field.
   */
  sharedRecordIdsByType?: Record<string, string[]>;
  /**
   * [#19] true when the expanded lists were too large to inline: `ownerIds`/
   * `sharedRecordIds` are EMPTY and `descriptor` carries the seeds for the domain
   * to resolve server-side. A deferred scope that has not been hydrated by the
   * domain is treated fail-closed (deny-all) by `buildVisibilityFilter`.
   */
  deferred?: boolean;
  /** [#19] compact seeds, present iff `deferred` — resolved server-side by the domain. */
  descriptor?: VisibilityScopeDescriptor;
  /**
   * [#19] Access epoch (K3, Д-4) the gateway resolved this scope at. The domain's
   * deferred-scope hydrator caches by `(projectId,userId,resource,epoch)` and
   * invalidates on epoch divergence — same contract the gateway ACCESS_CACHE uses.
   * Stamped by the gateway; absent on scopes from an older gateway (hydrator then
   * treats any cache entry as stale → re-resolves, still fail-closed).
   */
  epoch?: number;
  /**
   * [#19] The route resource the gateway resolved this scope for (contacts|deals|
   * …, or `''` for cross-resource routes). The domain hydrator MUST re-resolve
   * with THIS resource (not a domain constant) so the deferred path matches the
   * inline path byte-for-byte for shares. Stamped by the gateway.
   */
  resource?: string;
  /**
   * Viewer's direct org-unit ids (departments). Stamped by control/gateway for
   * department-scoped record ownership (e.g. deals with `departmentId` but no
   * personal assignee — FR-MDEAL-36 / FR-DEALS-315).
   */
  viewerUnitIds?: string[];
  /**
   * FR-CONTACTS-285: department/unit ids the viewer belongs to (control resolves
   * from org structure). Used by `buildOwnableVisibilityFilter` so records owned
   * by a department (`departmentId` set, `ownerId` unset) are visible to members of
   * that department. Small list — always inlined by the gateway (never deferred).
   */
  viewerDepartmentIds?: string[];
  /**
   * Department/unit ids whose department-owned records (`departmentId`) the viewer
   * may see (FR-COMPANIES-355 / FR-MCOM-35). Populated for restricted scopes when
   * the policy has department-level rules; empty for mode `all` and `only_own`.
   * Distinct from `viewerDepartmentIds` — used by `buildVisibilityFilter` for
   * company records where `departmentId ∈ departmentIds` even when `ownerId` is absent.
   */
  departmentIds?: string[];
}

/**
 * [#19] Count the ids that would be inlined for a restricted scope. `all`/absent
 * scopes carry no lists (0). Used by control to decide inline-vs-defer.
 */
export function visibilityScopeExpandedSize(
  ownerIds: readonly string[],
  sharedRecordIds: readonly string[],
): number {
  return ownerIds.length + sharedRecordIds.length;
}

function normalizeDescriptor(raw: unknown): VisibilityScopeDescriptor | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const d = raw as Partial<VisibilityScopeDescriptor>;
  const strArr = (v: unknown): string[] =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  return {
    unitIds: strArr(d.unitIds),
    ledUnitIds: strArr(d.ledUnitIds),
    selectedGroupIds: strArr(d.selectedGroupIds),
    ruleKinds: strArr(d.ruleKinds).filter((k): k is VisibilityRuleKind =>
      ['own', 'own_groups', 'own_subgroups', 'selected_groups', 'all'].includes(k),
    ),
    usesSharing: d.usesSharing === true,
    orgId: typeof d.orgId === 'string' ? d.orgId : '',
  };
}

/**
 * [TODO-109] Tolerant parse of the cross-resource share map: keep only
 * `string -> string[]` entries with at least one id. Returns undefined when
 * nothing usable is left, so the field stays absent rather than `{}`.
 */
function normalizeSharedByType(raw: unknown): Record<string, string[]> | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const out: Record<string, string[]> = {};
  for (const [type, ids] of Object.entries(raw as Record<string, unknown>)) {
    if (!type || !Array.isArray(ids)) continue;
    const clean = ids.filter((x): x is string => typeof x === 'string' && x !== '');
    if (clean.length) out[type] = clean;
  }
  return Object.keys(out).length ? out : undefined;
}

/** base64(JSON) so the scope survives as a single gRPC metadata value. */
export function serializeVisibilityScope(scope: VisibilityScope): string {
  return Buffer.from(JSON.stringify(scope), 'utf8').toString('base64');
}

export function parseVisibilityScope(raw: string | undefined | null): VisibilityScope | undefined {
  if (!raw || !raw.trim()) return undefined;
  try {
    const obj = JSON.parse(Buffer.from(raw.trim(), 'base64').toString('utf8')) as Partial<VisibilityScope>;
    if (obj.mode !== 'all' && obj.mode !== 'restricted') return undefined;
    const deferred = obj.deferred === true;
    const descriptor = deferred ? normalizeDescriptor(obj.descriptor) : undefined;
    // Fail-closed: a scope tagged deferred but carrying no descriptor is unusable
    // (the domain has nothing to resolve from) → drop it, so downstream treats it
    // as "no resolved scope" = deny-all rather than empty-list = show-nothing-but-own.
    if (deferred && !descriptor) return undefined;
    return {
      mode: obj.mode,
      level: isVisibilityLevel(obj.level) || obj.level === 'custom' ? obj.level : 'only_own',
      selfId: typeof obj.selfId === 'string' ? obj.selfId : '',
      ownerIds: Array.isArray(obj.ownerIds) ? obj.ownerIds.filter((x) => typeof x === 'string') : [],
      sharedRecordIds: Array.isArray(obj.sharedRecordIds)
        ? obj.sharedRecordIds.filter((x) => typeof x === 'string')
        : [],
      // [TODO-109] Cross-resource shares survive the metadata round-trip; absent
      // (single-resource routes) → field omitted, not an empty object.
      ...(() => {
        const byType = normalizeSharedByType(obj.sharedRecordIdsByType);
        return byType ? { sharedRecordIdsByType: byType } : {};
      })(),
      // [#19] Tolerant parse of the optional epoch/resource stamps (absent on
      // scopes from an older gateway — the hydrator degrades to re-resolve).
      ...(typeof obj.epoch === 'number' && Number.isFinite(obj.epoch) ? { epoch: obj.epoch } : {}),
      ...(typeof obj.resource === 'string' ? { resource: obj.resource } : {}),
      ...(Array.isArray(obj.viewerDepartmentIds)
        ? {
            viewerDepartmentIds: obj.viewerDepartmentIds.filter(
              (x): x is string => typeof x === 'string' && x !== '',
            ),
          }
        : {}),
      ...(Array.isArray(obj.departmentIds)
        ? {
            departmentIds: obj.departmentIds.filter(
              (x): x is string => typeof x === 'string' && x !== '',
            ),
          }
        : {}),
      ...(deferred ? { deferred: true, descriptor } : {}),
      ...(Array.isArray(obj.viewerUnitIds)
        ? { viewerUnitIds: obj.viewerUnitIds.filter((x): x is string => typeof x === 'string') }
        : {}),
    };
  } catch {
    return undefined;
  }
}

/**
 * [#19] Hydrate a deferred (oversized) scope with the flat lists the domain
 * resolved server-side from control. This is the ONLY approved place that clears
 * `deferred`/`descriptor`: after it, `buildVisibilityFilter`/`isRecordVisible`
 * apply the resolved lists exactly like an inline scope (no more deny-all branch).
 * `epoch`/`resource` stamps are preserved for cache keying. Returns a NEW scope
 * (the input is untouched); if the input was not deferred it is returned as-is.
 */
export function hydrateVisibilityScope(
  scope: VisibilityScope,
  resolved: {
    ownerIds: readonly string[];
    sharedRecordIds: readonly string[];
    departmentIds?: readonly string[];
  },
): VisibilityScope {
  if (!scope.deferred) return scope;
  const { descriptor: _d, deferred: _def, ...rest } = scope;
  void _d;
  void _def;
  return {
    ...rest,
    ownerIds: [...resolved.ownerIds],
    sharedRecordIds: [...resolved.sharedRecordIds],
    viewerUnitIds: scope.descriptor?.unitIds ?? scope.viewerUnitIds ?? [],
    viewerDepartmentIds:
      scope.descriptor?.unitIds ?? scope.viewerDepartmentIds ?? scope.viewerUnitIds ?? [],
    ...(resolved.departmentIds?.length
      ? { departmentIds: [...resolved.departmentIds] }
      : {}),
  };
}

/**
 * Always-false Mongo fragment: `$or:[]` throws natively, so we canonicalize a
 * deny-everything predicate (mirrors abac `compile-mongo` FALSE_FRAGMENT).
 * AND-ing this into any read filter makes the query return nothing.
 */
export const DENY_ALL_FILTER: Record<string, unknown> = { $nor: [{}] };

/**
 * Build the Mongo filter fragment enforcing a visibility scope. Domains AND this
 * into their base `{ projectId, ... }` query.
 *
 * Fail-closed contract (IMPLEMENTATION-DEBT Д-3):
 *  - scope absent / invalid (undefined) → **deny-all** (`DENY_ALL_FILTER`), NOT
 *    `null`/"show all". A missing scope means the gateway did not resolve access,
 *    so the domain must reveal nothing (only what's provably allowed = nothing
 *    record-wise without a resolved scope). Aggregates/exports inherit this since
 *    they AND the same fragment.
 *  - mode 'all'        → `null` (no record-level narrowing — explicitly resolved
 *    by the gateway for manager+/personal projects).
 *  - mode 'restricted' → owner ∈ ownerIds OR record ∈ sharedIds.
 *
 * @param ownerField  the document field carrying the owner user id ('ownerId' | 'assigneeId').
 * @param sharedIds   record ids (as the field's stored id type) explicitly shared with the viewer.
 * @param departmentField optional flat field for department-owned records (`departmentId`).
 */
export function buildVisibilityFilter<TId = unknown>(
  scope: VisibilityScope | undefined,
  ownerField: string,
  sharedIds: TId[] = [],
  departmentField?: string,
): Record<string, unknown> | null {
  // Fail-closed: no resolved scope → reveal nothing (Д-3), never fall through to "all".
  if (!scope) return { ...DENY_ALL_FILTER };
  if (scope.mode === 'all') return null;
  // [#19] Fail-closed: a DEFERRED (oversized) scope that the domain has NOT yet
  // hydrated carries empty ownerIds/sharedRecordIds. Building a filter from those
  // empty lists would leak nothing but the viewer's own records under a wider
  // intended scope — so deny-all instead. `hydrateVisibilityScope` (invoked by
  // VisibilityScopeHydrationGuard before the handler on a domain that wired it)
  // clears `deferred`, so this branch is not hit once the domain resolves. Domains
  // that have not yet wired the guard keep this safe fail-closed behaviour.
  if (scope.deferred) return { ...DENY_ALL_FILTER };
  const or: Record<string, unknown>[] = [{ [ownerField]: { $in: scope.ownerIds } }];
  const deptIds = (scope.departmentIds ?? []).filter((d) => d !== '');
  if (departmentField && deptIds.length) {
    or.push({ [departmentField]: { $in: deptIds } });
  }
  if (sharedIds.length) or.push({ _id: { $in: sharedIds } });
  return or.length === 1 ? or[0] : { $or: or };
}

/**
 * FR-CONTACTS-285: visibility for XOR ownership (user `ownerField` OR department
 * `departmentField`). Records with a user owner match the owner branch; records
 * with no user owner but a department owner match when `departmentField` ∈
 * `scope.viewerDepartmentIds`. Shares append as a third disjunct on `_id`.
 *
 * Fail-closed contract matches `buildVisibilityFilter` (deny-all when scope
 * absent / deferred-unhydrated; `null` when mode `all`).
 */
export function buildOwnableVisibilityFilter<TId = unknown>(
  scope: VisibilityScope | undefined,
  ownerField: string,
  departmentField: string | undefined,
  sharedIds: TId[] = [],
): Record<string, unknown> | null {
  if (!scope) return { ...DENY_ALL_FILTER };
  if (scope.mode === 'all') return null;
  if (scope.deferred) return { ...DENY_ALL_FILTER };

  const or: Record<string, unknown>[] = [{ [ownerField]: { $in: scope.ownerIds } }];
  if (sharedIds.length) or.push({ _id: { $in: sharedIds } });

  const deptIds = (scope.viewerDepartmentIds ?? []).filter((d) => d !== '');
  if (departmentField && deptIds.length) {
    or.push({
      $and: [
        { [departmentField]: { $in: deptIds } },
        {
          $or: [
            { [ownerField]: null },
            { [ownerField]: '' },
            { [ownerField]: { $exists: false } },
          ],
        },
      ],
    });
  }

  return or.length === 1 ? or[0] : { $or: or };
}

/**
 * Single-record counterpart of `buildOwnableVisibilityFilter` (FR-CONTACTS-285).
 * Owner XOR department: a user-owned record matches `ownerIds`; a department-owned
 * record (no user owner) matches when `departmentId` ∈ `viewerDepartmentIds`.
 */
export function isOwnableRecordVisible(
  scope: VisibilityScope | undefined,
  ownerId: string | undefined | null,
  departmentId?: string | null,
  isShared = false,
): boolean {
  if (!scope) return false;
  if (scope.mode === 'all') return true;
  if (scope.deferred) return false;
  if (isShared) return true;
  if (ownerId != null && ownerId !== '' && scope.ownerIds.includes(ownerId)) return true;
  const dept = departmentId != null && departmentId !== '' ? departmentId : '';
  if (!dept) return false;
  if (ownerId != null && ownerId !== '') return false;
  return (scope.viewerDepartmentIds ?? []).includes(dept);
}

/**
 * [TODO-109] Visibility filter for a CROSS-ENTITY store (the search index): one
 * collection holding rows of many resources, where a record is identified by
 * `(entityType, entityId)` and NOT by the row's own `_id`.
 *
 * `buildVisibilityFilter` cannot serve such a store: its share disjunct is
 * `_id ∈ sharedIds`, and the shared ids are the SOURCE record ids — matching them
 * against the index document ids never hits, so shared records stayed invisible in
 * global search. Here the share disjunct is built per entity type instead, from
 * `scope.sharedRecordIdsByType` (resolved cross-resource by the gateway).
 *
 * The fail-closed contract is inherited verbatim by delegating the owner branch to
 * `buildVisibilityFilter`: no scope / unhydrated deferred scope → deny-all (shares
 * are NOT appended to a deny-all: an unresolved scope must reveal nothing), mode
 * `all` → null. `scope.sharedRecordIds` is deliberately ignored — for a
 * cross-resource route it is empty by construction and, if ever populated, would
 * carry ids of one unknown resource.
 */
export function buildCrossEntityVisibilityFilter(
  scope: VisibilityScope | undefined,
  ownerField: string,
  fields: { typeField: string; idField: string },
): Record<string, unknown> | null {
  const base = buildVisibilityFilter(scope, ownerField, []);
  // null = mode 'all' (no narrowing); `$nor` = the fail-closed deny-all fragment.
  if (base === null || '$nor' in base) return base;
  const or: Record<string, unknown>[] = [base];
  for (const [type, ids] of Object.entries(scope?.sharedRecordIdsByType ?? {})) {
    const unique = [...new Set(ids ?? [])];
    if (!type || unique.length === 0) continue;
    or.push({ [fields.typeField]: type, [fields.idField]: { $in: unique } });
  }
  return or.length === 1 ? or[0] : { $or: or };
}

/**
 * True if the viewer may see a single record given its owner id + whether it's
 * shared with them. Fail-closed (Д-3): a missing/invalid scope denies the record
 * (returns false), never grants it.
 */
export function isRecordVisible(
  scope: VisibilityScope | undefined,
  ownerId: string | undefined | null,
  isShared = false,
  departmentId?: string | null,
): boolean {
  // Fail-closed: no resolved scope → deny (was: return true — fail-open hole, Д-3).
  if (!scope) return false;
  if (scope.mode === 'all') return true;
  // [#19] Fail-closed for an unhydrated deferred scope (empty lists ≠ "denied").
  if (scope.deferred) return false;
  if (isShared) return true;
  if (ownerId != null && scope.ownerIds.includes(ownerId)) return true;
  const dept = departmentId?.trim();
  if (dept && (scope.departmentIds ?? []).includes(dept)) return true;
  return false;
}
