/**
 * RBAC layer-1 engine (E2-01 + E2-02). Source of truth: docs/tz/areas/
 * permission-rbac/TZ.md, docs/tz/rfc/RFC-1-actions.md, contracts/control.md.
 *
 * This module is the single, storage-neutral place that answers "may subject X
 * perform action A on subject S in this project" at the RBAC layer (the first,
 * cheapest cut of the permission pipeline, before ABAC/visibility/sharing). It:
 *
 *  - hosts the **system role → permission-set expansion** (§7.4) that moves the
 *    legacy code matrix (`PROJECT_ROLE_ACTIONS`, rbac.ts) into data: a seed of
 *    `subject:action` keys per system role, scoped to a catalog (FR-PERM-1);
 *  - declares the **system subjects** of the engine (`roles`, `project`,
 *    `members`, `org`) that exist in every project's catalog (FR-PERM-24);
 *  - holds the **decorator → catalog subject map** (FR-PERM-25) so guards that
 *    say `@RequirePermission('deals','move')` are checked against the granular
 *    catalog key `deals.stage:move`, fail-closed when no mapping exists;
 *  - compiles an **effective permission-set** (allow ∪ / deny-overlay, deny>allow,
 *    least-privilege default) from role permissions + grants (FR-PERM-5/7/9);
 *  - enforces the **system deny-invariants** (§7.6) and **no-self-escalation**
 *    (§7.5) — both fail-closed.
 *
 * Storage-neutral on purpose: control passes plain `subject:action` strings; this
 * module never touches Prisma/Mongo. `write`=create+update; the action vocabulary
 * is the closed canon from rbac.ts / RFC-1 (synonyms normalized via
 * `normalizeAction`, module-manifest.ts).
 */

import {
  PROJECT_ROLES,
  PROJECT_ROLE_KEY_ALLOWLIST,
  PROJECT_ROLE_KEY_DENYLIST,
  type ProjectRole,
  type PermissionAction,
} from './rbac';
import {
  buildProjectPermissionCatalog,
  type ModuleDefinition,
} from './module-registry';
import { moduleDefinitionToManifest, normalizeAction } from './module-manifest';
import {
  buildPermissionCatalog,
  permissionKey,
  parsePermissionKey,
  SYSTEM_PERMISSION_MODULE_ID,
  type PermissionCatalog,
  type PermissionKey,
} from './permission-catalog';

// ───────────────────────────────────────────────────────────────────────────
// System subjects of the permission engine (FR-PERM-24).
//
// These are owned by the always-present system ("non-removable") modules
// "Проект" / "Профиль" / "Организация". They live in the catalog of EVERY
// project regardless of which business modules are enabled, so the role editor
// (`roles:manage`) and project administration are always gateable. Their absence
// from the catalog is a core defect, not a valid configuration.
// ───────────────────────────────────────────────────────────────────────────

/**
 * Project-level system subjects + their canonical actions (FR-PERM-24). Modeled
 * as a `ModuleDefinition` so they flow through the exact same catalog builder as
 * business modules (no second code path / no hand-written catalog).
 */
const SYSTEM_PERMISSION_MODULE: ModuleDefinition = {
  id: SYSTEM_PERMISSION_MODULE_ID,
  name: 'Системный',
  description: 'Системные subject движка прав (роли, проект, участники).',
  locked: true,
  dependencies: [],
  integrationMethods: [],
  personalSettingsSchema: {},
  integrationSettingsSchema: {},
  policyCapabilities: [
    // Role editor / catalog. `roles:read` — view roles & simulator; `roles:manage`
    // — CRUD custom roles + grant/revoke (owner/admin).
    { subject: 'roles', actions: ['read', 'manage'] },
    // Project administration. `project:delete` is owner-only (§7.6).
    { subject: 'project', actions: ['read', 'manage', 'delete'] },
    // Membership management (add/remove members, assign base role).
    { subject: 'members', actions: ['manage'] },
  ],
};

/**
 * Org-level system subjects (FR-PERM-26 / FR-PERM-28). These are resolved on the
 * gateway against the organization (control is the authority on org membership /
 * structure), NOT through the per-project RBAC matrix — a project `owner` does
 * not carry them. Kept here as the single declaration of the org-level keys.
 */
export const ORG_SYSTEM_PERMISSIONS = {
  rolesRead: 'org:roles:read',
  rolesManage: 'org:roles:manage',
} as const;

/**
 * Canonical org-level permission keys an org role carries (FR-PERM-26 / -28).
 * `platform_owner` carries everything; `platform_admin` carries read + overview;
 * `employee` carries nothing org-level by default.
 */
export const ORG_ROLE_PERMISSIONS: Record<string, readonly string[]> = {
  platform_owner: [
    ORG_SYSTEM_PERMISSIONS.rolesRead,
    ORG_SYSTEM_PERMISSIONS.rolesManage,
  ],
  platform_admin: [ORG_SYSTEM_PERMISSIONS.rolesRead],
  employee: [],
};

/** True if an org role carries the given org-level permission key. */
export function orgRoleHasPermission(
  role: string | undefined | null,
  key: string,
): boolean {
  if (!role) return false;
  return (ORG_ROLE_PERMISSIONS[role] ?? []).includes(key);
}

// ───────────────────────────────────────────────────────────────────────────
// Project catalog including system subjects (FR-PERM-2 / FR-PERM-24).
// ───────────────────────────────────────────────────────────────────────────

let cachedSystemCatalog: PermissionCatalog | null = null;
function systemSubjectsCatalog(): PermissionCatalog {
  if (!cachedSystemCatalog) {
    cachedSystemCatalog = buildPermissionCatalog([
      moduleDefinitionToManifest(SYSTEM_PERMISSION_MODULE),
    ]);
  }
  return cachedSystemCatalog;
}

/**
 * Catalog of a project = union of `policyCapabilities` of enabled business
 * modules **plus** the always-present system subjects (FR-PERM-2/24). This is the
 * catalog roles/grants are validated against (V1) and the role editor reads.
 */
export function buildProjectCatalogWithSystem(
  enabledModuleIds: string[],
): PermissionCatalog {
  const business = buildProjectPermissionCatalog(enabledModuleIds);
  const system = systemSubjectsCatalog();
  const keys = new Set<PermissionKey>([...business.keys, ...system.keys]);
  // Merge grouped entries.
  const bySubject = new Map<string, Set<PermissionAction>>();
  for (const entry of [...business.entries, ...system.entries]) {
    let set = bySubject.get(entry.subject);
    if (!set) {
      set = new Set();
      bySubject.set(entry.subject, set);
    }
    for (const a of entry.actions) set.add(a);
  }
  const entries = Array.from(bySubject.entries())
    .map(([subject, actions]) => ({
      subject,
      actions: Array.from(actions).sort(),
      moduleIds: [] as string[],
    }))
    .sort((a, b) => a.subject.localeCompare(b.subject));
  return {
    entries,
    keys: Array.from(keys).sort(),
    has(subject: string, action: string): boolean {
      return keys.has(`${subject}:${action}` as PermissionKey);
    },
    hasKey(key: string): boolean {
      return keys.has(key as PermissionKey);
    },
  };
}

// ───────────────────────────────────────────────────────────────────────────
// System role → permission-set expansion (§7.4, FR-PERM-1).
//
// The legacy matrix is role × action (subject-independent). To move roles into
// data we expand each (role, action) over the catalog subjects, with the
// "elevated pair" carve-outs of §7.4 so member/viewer do not silently gain
// `*:manage` / `*:delete` / `reports:export`.
// ───────────────────────────────────────────────────────────────────────────

/** Stable seed keys of the five system project roles (FR-PERM-1). */
export const SYSTEM_PROJECT_ROLE_KEYS = PROJECT_ROLES;

/**
 * Actions each system role may hold, BEFORE the elevated-pair carve-out. Mirrors
 * `PROJECT_ROLE_ACTIONS` (rbac.ts) — kept in lock-step so seed == legacy matrix.
 */
const SYSTEM_ROLE_ACTIONS: Record<ProjectRole, ReadonlySet<PermissionAction>> = {
  owner: new Set<PermissionAction>([
    'read', 'write', 'delete', 'manage', 'move', 'export', 'import', 'execute', 'invoke', 'moderate',
  ]),
  admin: new Set<PermissionAction>([
    'read', 'write', 'delete', 'manage', 'move', 'export', 'import', 'execute', 'invoke', 'moderate',
  ]),
  manager: new Set<PermissionAction>([
    'read', 'write', 'delete', 'move', 'export', 'import', 'execute', 'invoke', 'moderate',
  ]),
  member: new Set<PermissionAction>(['read', 'write', 'move', 'export']),
  viewer: new Set<PermissionAction>(['read']),
};

/**
 * "Elevated" subject:action pairs that are NOT granted to member/viewer even if
 * the role nominally holds the action (§7.4 step 2, closing critique B3). `manage`
 * and `delete` are already excluded by the role's action set for member/viewer;
 * the carve-out here is the *analytic export* case: `reports:export` (and other
 * analytic subjects) is elevated, while working-data export
 * (`deals:export`, `contacts:export`, …) stays for member.
 *
 * CANON (do not change without an owner decision recorded there):
 *   `docs/20-requirements/17-reports.md` §2 «Роли и права» —
 *   `reports:export`: owner ✅ · admin ✅ · manager ✅ · member ❌ · viewer ❌,
 *   with footnote ¹ → OQ-REPORTS-060 («Экспорт Member'ом собственного среза —
 *   включать или оставить право только у Manager+», still open). So manager+ is
 *   the canonical default; granting it to `member` is the change that needs the
 *   owner, not keeping it out.
 *
 * TODO-027 made this load-bearing on the LIVE route: the gateway PEP now takes
 * the granular verdict (`decideRbac` over this expansion) as authoritative, where
 * before it shaped only the materialized roles, the role editor and the FE
 * projection (which already hid the export button for a member). Both sides now
 * say the same thing; the flat role×action matrix — which has no subject axis and
 * cannot express a per-subject carve-out — was the side that disagreed with the
 * canon. Parity is pinned in `gateway/src/guards/permission-parity.spec.ts`.
 *
 * `statistics` is listed here for symmetry with `reports` — analytic export is
 * elevated for member/viewer on both subjects (OQ-STAT-040 / FR-STAT-020).
 */
const ELEVATED_EXPORT_SUBJECTS = new Set<string>(['reports', 'statistics']);

function isElevatedForLowRole(subject: string, action: PermissionAction): boolean {
  // manage/delete are never given to member/viewer (defence-in-depth even though
  // SYSTEM_ROLE_ACTIONS already excludes them).
  if (action === 'manage' || action === 'delete') return true;
  // bulk import is a mass mutation — elevated on every subject (defence-in-depth:
  // member/viewer never gain `*:import` even if a role expansion nominally holds it).
  if (action === 'import') return true;
  // analytic export is elevated.
  if (action === 'export' && ELEVATED_EXPORT_SUBJECTS.has(subject)) return true;
  return false;
}

/**
 * Whether a role is "low" (member/viewer) for elevated-pair carve-out purposes.
 */
function isLowRole(role: ProjectRole): boolean {
  return role === 'member' || role === 'viewer';
}

/**
 * Expand a system role into a concrete set of catalog `subject:action` keys
 * (§7.4). Only pairs that exist in the catalog are emitted (so `statistics:write`
 * is never produced — statistics has only `read`). The result is the source of
 * truth seeded into `RolePermission`.
 *
 * @param role     one of owner|admin|manager|member|viewer
 * @param catalog  the project catalog (business + system subjects, FR-PERM-24)
 */
export function expandSystemRolePermissions(
  role: ProjectRole,
  catalog: PermissionCatalog,
): PermissionKey[] {
  const actions = SYSTEM_ROLE_ACTIONS[role];
  if (!actions) return [];
  const out = new Set<PermissionKey>();
  const low = isLowRole(role);
  for (const entry of catalog.entries) {
    for (const action of entry.actions) {
      if (!actions.has(action)) continue;
      if (low && isElevatedForLowRole(entry.subject, action)) continue;
      out.add(permissionKey(entry.subject, action));
    }
  }
  // Granular per-role key allow-list (rbac.ts, owner decision 2026-08-16):
  // specific catalog keys a role holds WITHOUT holding the action globally
  // (e.g. member + `documents.generate:execute`). Kept in lock-step with the
  // gateway PEP (`projectRoleCanKey`) by sharing the same constant. Only keys
  // that exist in the catalog and pass the §7.6 deny-invariants are emitted —
  // the allow-list can never smuggle a forbidden or off-catalog key.
  const extras = PROJECT_ROLE_KEY_ALLOWLIST[role];
  if (extras) {
    for (const key of extras) {
      if (catalog.hasKey(key) && isProjectGrantablePermission(key)) {
        out.add(key as PermissionKey);
      }
    }
  }
  const deny = PROJECT_ROLE_KEY_DENYLIST[role];
  if (deny) {
    for (const key of deny) {
      out.delete(key as PermissionKey);
    }
  }
  return Array.from(out).sort();
}

/**
 * Expanded permission-sets of ALL five system roles for a given catalog. Used by
 * the control seed/sync (FR-PERM-1) to materialize immutable system roles.
 */
export function expandAllSystemRoles(
  catalog: PermissionCatalog,
): Record<ProjectRole, PermissionKey[]> {
  return {
    owner: expandSystemRolePermissions('owner', catalog),
    admin: expandSystemRolePermissions('admin', catalog),
    manager: expandSystemRolePermissions('manager', catalog),
    member: expandSystemRolePermissions('member', catalog),
    viewer: expandSystemRolePermissions('viewer', catalog),
  };
}

// ───────────────────────────────────────────────────────────────────────────
// Decorator subject → catalog subject map (FR-PERM-25).
//
// Guards say `@RequirePermission('deals','move')` (module subject) but the
// catalog stores `deals.stage:move` (granular subject). A check resolves the
// decorator pair to one-or-more catalog keys; if no mapping exists, the guard
// MUST fail-closed (PERMISSION_MAPPING_MISSING) rather than invent a key.
// ───────────────────────────────────────────────────────────────────────────

/**
 * Explicit decorator (subject,action) → catalog keys overrides (FR-PERM-25).
 *
 * TODO-027 — every entry here is now load-bearing: since the gateway PEP enforces
 * `decideRbac` on the hot path, an override pointing at a key that does not exist
 * in the catalog silently turns the whole route into "no granular opinion"
 * (`PERMISSION_MAPPING_MISSING` → `not_applicable`), i.e. deny-grants stop
 * applying to it. Keep this map in lock-step with the catalog
 * (`buildProjectCatalogWithSystem` over the module manifests).
 */
const DECORATOR_SUBJECT_MAP: Record<string, PermissionKey[]> = {
  // `move` over a deal means moving its stage (RFC-1 §1.2). NB: the orders module
  // models the same capability as a plain `orders:move` catalog key (there is no
  // `orders.stage` subject in its manifest), so the mirror override that used to
  // live here ('orders:move' → 'orders.stage:move') resolved to a non-existent key
  // and is intentionally gone — the identity mapping is the correct one.
  'deals:move': ['deals.stage:move'],
  // RFC-1 §1.4 subject splits.
  'documents:generate': ['documents.generate:execute'],
  'companies:reassign': ['companies.owner:write'],
  'access:simulate': ['access:read'],
  // Company merge (`POST /v1/companies/merge[/preview]`, decorator
  // `companies:execute`). The companies manifest has no `execute` capability, so
  // without a mapping the route would carry no granular opinion at all. A merge
  // rewrites the master AND removes the loser, so it is exactly write ∧ delete —
  // and that conjunction reproduces the legacy flat-matrix row for
  // `companies:execute` (owner/admin/manager allow, member/viewer deny) key-for-key.
  // If `companies:execute` is ever added to the manifest, drop this override.
  'companies:execute': ['companies:write', 'companies:delete'],
};

/**
 * Resolve a decorator `(subject, action)` to the catalog key(s) that must be
 * present in the effective allow-set for the check to pass (FR-PERM-25).
 *
 *  - If the action is a synonym (`create`/`update`), it is normalized to `write`.
 *  - If an explicit override exists, it wins.
 *  - Otherwise the identity key `subject:action` is used IF it exists in the
 *    catalog; if not, returns `null` → caller must fail-closed
 *    (`PERMISSION_MAPPING_MISSING`).
 */
export function resolveDecoratorPermission(
  subject: string,
  action: string,
  catalog: PermissionCatalog,
): PermissionKey[] | null {
  const normAction = normalizeAction(action);
  const override = DECORATOR_SUBJECT_MAP[`${subject}:${action}`] ??
    DECORATOR_SUBJECT_MAP[`${subject}:${normAction}`];
  if (override) {
    // Every mapped key must exist in the catalog, else the mapping is stale.
    return override.every((k) => catalog.hasKey(k)) ? override : null;
  }
  const identity = `${subject}:${normAction}` as PermissionKey;
  if (catalog.hasKey(identity)) return [identity];
  return null;
}

// ───────────────────────────────────────────────────────────────────────────
// System deny-invariants (§7.6, BR-PERM-10) — never overridable.
// ───────────────────────────────────────────────────────────────────────────

/**
 * Subjects/actions a project role / custom role / allow-grant can NEVER grant
 * (§7.6.1). These are reserved for system org-roles. Checked at both compile
 * (effective set never contains them via project roles) and at role-save /
 * grant time (cannot be put into a project role).
 */
function isForbiddenProjectPermission(subject: string, action: string): boolean {
  // `auth:*` — never reachable by project roles.
  if (subject === 'auth' || subject.startsWith('auth.')) return true;
  // `billing:manage`, `org:manage` and any org-level subject are org-only.
  if (subject === 'billing' && action === 'manage') return true;
  if (subject === 'org' || subject.startsWith('org.') || subject.startsWith('org:')) {
    return true;
  }
  return false;
}

/**
 * Validate that a permission key is allowed to appear in a *project* role/grant
 * (V-§7.6 / V-§7.7). `project:delete` is owner-only and handled separately at
 * assignment time (it stays in the catalog so owner's role carries it).
 */
export function isProjectGrantablePermission(key: string): boolean {
  const parsed = parsePermissionKey(key);
  if (!parsed) return false;
  return !isForbiddenProjectPermission(parsed.subject, parsed.action);
}

// ───────────────────────────────────────────────────────────────────────────
// Effective permission-set compiler (FR-PERM-5/7/8/9, §7.1).
//
// Inputs are already-loaded role permissions + grants from control. The compiler
// is pure: deny > allow, allow = ∃ grant, default = deny (least privilege).
// ───────────────────────────────────────────────────────────────────────────

/** One role assignment's contribution, already resolved to permission keys. */
export interface CompiledRoleInput {
  /** `subject:action` keys the role holds (from RolePermission). */
  permissionKeys: string[];
  /**
   * Module scope filter: when set, only keys whose subject belongs to this
   * module (by `dataSubjects` / namespace) are effective (FR-PERM-4 / BR-PERM-8).
   * `undefined` = project-wide.
   */
  moduleScope?: string;
  /** Provenance label for FR-ACCESS-550 (e.g. `baseline:member`, `assignment:manager`). */
  source?: string;
}

/** An allow/deny grant overlay (PermissionGrant), already filtered to this user. */
export interface CompiledGrantInput {
  effect: 'allow' | 'deny';
  /** `subject:action` key. */
  key: string;
  /** Provenance label for FR-ACCESS-550 (defaults to `grant:<effect>`). */
  source?: string;
}

export interface EffectivePermissionSet {
  /** Sorted `subject:action` keys the subject may perform. */
  allow: string[];
  /** Sorted `subject:action` keys explicitly denied (deny>allow already applied to allow). */
  deny: string[];
}

/** Per-key dominant provenance label (FR-ACCESS-550). */
export type PermissionProvenanceMap = Record<string, string>;

export interface EffectivePermissionSetWithSources extends EffectivePermissionSet {
  sources: PermissionProvenanceMap;
}

/**
 * Whether a catalog key belongs to a module scope. A key is in `module:<id>`
 * scope iff its subject is `<id>` or `<id>.<...>` (namespace), OR it is a system
 * subject (system subjects are always project-wide and ignored by module scope).
 */
function keyInModuleScope(key: string, moduleScope: string): boolean {
  const parsed = parsePermissionKey(key);
  if (!parsed) return false;
  return parsed.subject === moduleScope || parsed.subject.startsWith(`${moduleScope}.`);
}

/**
 * Compile the effective allow/deny permission-set (FR-PERM-5/7/9, BR-PERM-7/9).
 *
 *  1. allow = union of all role permission keys (module-scoped filtered) ∪ allow
 *     grants. Monotone — only adds.
 *  2. deny  = union of deny grants ∪ system deny-invariants (§7.6) for project
 *     subjects that snuck in (defence-in-depth — they should never be granted).
 *  3. effective allow = allow \ deny (deny > allow, BR-PERM-9).
 *  4. keys not present anywhere → not in allow (least privilege default).
 *
 * @param catalogKeys  the set of catalog keys this project recognizes; allow is
 *                     intersected with it so orphan permissions of disabled
 *                     modules silently drop (FR-PERM-12) without being lost in
 *                     storage.
 */
export function compileEffectivePermissions(
  roles: CompiledRoleInput[],
  grants: CompiledGrantInput[],
  catalogKeys: ReadonlySet<string>,
): EffectivePermissionSet {
  const { allow, deny } = compileEffectivePermissionsWithSources(roles, grants, catalogKeys);
  return { allow, deny };
}

/**
 * Like {@link compileEffectivePermissions} but also returns per-key provenance
 * (FR-ACCESS-550). Denied keys are tagged with their deny source; effective
 * allow keys carry the first contributing source before deny subtraction.
 */
export function compileEffectivePermissionsWithSources(
  roles: CompiledRoleInput[],
  grants: CompiledGrantInput[],
  catalogKeys: ReadonlySet<string>,
): EffectivePermissionSetWithSources {
  const allow = new Set<string>();
  const deny = new Set<string>();
  const sources: PermissionProvenanceMap = {};

  const tagAllow = (key: string, source: string) => {
    if (!sources[key]) sources[key] = source;
  };

  for (const role of roles) {
    const src = role.source ?? 'role';
    for (const key of role.permissionKeys) {
      if (!catalogKeys.has(key)) continue;
      if (role.moduleScope && !keyInModuleScope(key, role.moduleScope)) continue;
      if (!isProjectGrantablePermission(key)) continue;
      allow.add(key);
      tagAllow(key, src);
    }
  }

  for (const grant of grants) {
    if (!catalogKeys.has(grant.key)) continue;
    const src = grant.source ?? `grant:${grant.effect}`;
    if (grant.effect === 'deny') {
      deny.add(grant.key);
      sources[grant.key] = src;
    } else {
      if (!isProjectGrantablePermission(grant.key)) continue;
      allow.add(grant.key);
      tagAllow(grant.key, src);
    }
  }

  for (const d of deny) allow.delete(d);

  return {
    allow: Array.from(allow).sort(),
    deny: Array.from(deny).sort(),
    sources,
  };
}

/**
 * RBAC decision for a decorator `(subject, action)` against an effective set,
 * resolved through the decorator map (FR-PERM-6/25). Fail-closed: missing
 * mapping → deny with reason `PERMISSION_MAPPING_MISSING`.
 */
export interface RbacDecision {
  decision: 'allow' | 'deny';
  reason:
    | 'OK'
    | 'NOT_IN_ANY_ROLE'
    | 'DENIED_BY_GRANT'
    | 'PERMISSION_MAPPING_MISSING';
  /** Catalog keys the decision was resolved against. */
  matchedKeys: string[];
}

export function decideRbac(
  subject: string,
  action: string,
  effective: EffectivePermissionSet,
  catalog: PermissionCatalog,
): RbacDecision {
  const keys = resolveDecoratorPermission(subject, action, catalog);
  if (!keys || keys.length === 0) {
    return { decision: 'deny', reason: 'PERMISSION_MAPPING_MISSING', matchedKeys: [] };
  }
  const denySet = new Set(effective.deny);
  const allowSet = new Set(effective.allow);
  // deny > allow: if any mapped key is denied, deny.
  if (keys.some((k) => denySet.has(k))) {
    return { decision: 'deny', reason: 'DENIED_BY_GRANT', matchedKeys: keys };
  }
  // All mapped keys must be allowed (AND semantics for multi-key mappings).
  if (keys.every((k) => allowSet.has(k))) {
    return { decision: 'allow', reason: 'OK', matchedKeys: keys };
  }
  return { decision: 'deny', reason: 'NOT_IN_ANY_ROLE', matchedKeys: keys };
}

// ───────────────────────────────────────────────────────────────────────────
// No-self-escalation (§7.5, FR-PERM-10) — fail-closed.
// ───────────────────────────────────────────────────────────────────────────

/**
 * Whether `actor` (by their effective allow set, after deny subtraction) may
 * grant the permission keys `requested` into a role/grant (§7.5).
 *
 *  - `owner` may grant any catalog key in the project (returns ok always).
 *  - otherwise every requested key must be in `actorAllow \ actorDeny`.
 *
 * Returns the offending keys (empty = ok).
 */
export function checkNoSelfEscalation(params: {
  isOwner: boolean;
  actorAllow: string[];
  actorDeny: string[];
  requested: string[];
}): { ok: boolean; offending: string[] } {
  if (params.isOwner) return { ok: true, offending: [] };
  const allow = new Set(params.actorAllow);
  for (const d of params.actorDeny) allow.delete(d);
  const offending = params.requested.filter((k) => !allow.has(k));
  return { ok: offending.length === 0, offending };
}
