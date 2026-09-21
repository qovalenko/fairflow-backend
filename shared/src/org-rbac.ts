/**
 * Org-structure RBAC (P8 T4.1, E-ORG). The meta-level — protecting the
 * organization structure itself (employees / departments / units / invitations /
 * profile / audit / seats) — moves from the binary `orgRoleCanManage`
 * (owner/admin vs everyone) onto the same permission-set engine the project RBAC
 * uses. This is the single, storage-neutral declaration of:
 *
 *  - the **org-subject vocabulary** (`ORG_STRUCTURE_SUBJECTS`) — the granular
 *    `subject:action` keys an org role may carry;
 *  - the **system org-role → permission-set expansion**
 *    (`expandSystemOrgRolePermissions`) mapping `platform_owner` /
 *    `platform_admin` / `employee` onto concrete key sets. `owner`/`admin` are
 *    byte-for-byte the union `orgRoleCanManage` used to gate (full manage of the
 *    structure) plus the reads; `employee` is the read-only structure view
 *    (exactly what control let a plain member see before) — so the default
 *    behaviour is preserved;
 *  - the **org catalog** (`buildOrgStructureCatalog`) roles/grants validate
 *    against;
 *  - **`isOrgStructureGrantablePermission`** — the org counterpart of
 *    `isProjectGrantablePermission` (the project one rejects EVERY `org:` key, so
 *    org roles need their own grantability gate for no-self-escalation).
 *
 * NOTE: this vocabulary is DISTINCT from the gateway's `org:roles` keys in
 * `ORG_SYSTEM_PERMISSIONS` (permission-rbac.ts, used by the T3.1
 * OrgAccessGuard) — those gate the role-editor endpoints, these gate
 * the structure mutations. Both live under the `org:` namespace by design.
 *
 * Storage-neutral on purpose: control passes plain `subject:action` strings; this
 * module never touches Prisma.
 */

import type { PermissionAction } from './rbac';
import {
  permissionKey,
  parsePermissionKey,
  type PermissionCatalog,
  type PermissionKey,
} from './permission-catalog';

/**
 * The org-structure subject vocabulary (curator decision, canonical for T4.1).
 * Each subject lists the actions it supports. `manage` implies the ability to
 * mutate; `read` gates listing/viewing. Structure = employees + departments +
 * units; plus invitations, org profile, audit trail and seats.
 */
export const ORG_STRUCTURE_SUBJECTS: Readonly<Record<string, readonly PermissionAction[]>> = {
  'org:employees': ['read', 'manage'],
  'org:departments': ['read', 'manage'],
  // FR-MORG-7/8: department→project bindings (auto-membership intent). Read gates
  // listing a department's bindings; manage gates create/update/delete.
  'org:bindings': ['read', 'manage'],
  'org:units': ['read', 'manage'],
  'org:invitations': ['manage'],
  'org:profile': ['read', 'manage'],
  'org:audit': ['read'],
  'org:seats': ['read'],
} as const;

/** Flat set of every valid org-structure `subject:action` key. */
export const ORG_STRUCTURE_KEYS: readonly PermissionKey[] = Object.entries(ORG_STRUCTURE_SUBJECTS)
  .flatMap(([subject, actions]) => actions.map((a) => permissionKey(subject, a)))
  .sort();

const ORG_STRUCTURE_KEY_SET: ReadonlySet<string> = new Set(ORG_STRUCTURE_KEYS);

/** True iff `key` is a recognized org-structure permission key. */
export function isOrgStructureKey(key: string): boolean {
  return ORG_STRUCTURE_KEY_SET.has(key);
}

/**
 * True iff `key` may appear in an org role / org allow-grant. The project
 * grantability gate (`isProjectGrantablePermission`) rejects every `org:` key
 * (they are org-only), so org roles use this dedicated gate: a key is grantable
 * iff it is part of the org-structure vocabulary (no smuggling project or `auth:`
 * keys into an org role).
 */
export function isOrgStructureGrantablePermission(key: string): boolean {
  const parsed = parsePermissionKey(key);
  if (!parsed) return false;
  return ORG_STRUCTURE_KEY_SET.has(key);
}

/**
 * Build the org-structure permission catalog (the validation surface for org
 * roles/grants, V1). Deterministic/sorted so it is diff-stable. Unlike the
 * project catalog this is module-independent — the org structure is always
 * present.
 */
let cachedOrgCatalog: PermissionCatalog | null = null;
export function buildOrgStructureCatalog(): PermissionCatalog {
  if (cachedOrgCatalog) return cachedOrgCatalog;
  const entries = Object.entries(ORG_STRUCTURE_SUBJECTS)
    .map(([subject, actions]) => ({
      subject,
      actions: [...actions].sort(),
      moduleIds: [] as string[],
    }))
    .sort((a, b) => a.subject.localeCompare(b.subject));
  const keySet = new Set<string>(ORG_STRUCTURE_KEYS);
  cachedOrgCatalog = {
    entries,
    keys: [...ORG_STRUCTURE_KEYS],
    has(subject: string, action: string): boolean {
      return keySet.has(`${subject}:${action}`);
    },
    hasKey(key: string): boolean {
      return keySet.has(key);
    },
  };
  return cachedOrgCatalog;
}

// ───────────────────────────────────────────────────────────────────────────
// System org-role → permission-set expansion (P8 T4.1).
//
// `platform_owner` / `platform_admin` carry the FULL vocabulary — this is the
// exact set of actions the old binary `orgRoleCanManage` gated (it never
// distinguished owner from admin, so neither do we — default preserved). The
// `employee` role carries only the read-part of the structure: exactly what
// control let a plain member list before (employees/departments/units/seats +
// profile read), and NOT audit or invitations (those were owner/admin-only).
// ───────────────────────────────────────────────────────────────────────────

/** Stable keys of the three immutable system org roles. */
export const SYSTEM_ORG_ROLE_KEYS = ['platform_owner', 'platform_admin', 'employee'] as const;
export type SystemOrgRoleKey = (typeof SYSTEM_ORG_ROLE_KEYS)[number];

/** Read-only structure view a plain `employee` carries by default. */
const EMPLOYEE_ORG_KEYS: readonly PermissionKey[] = [
  'org:employees:read',
  'org:departments:read',
  // Symmetric with departments:read — a plain employee that may see the org's
  // departments may also see which projects those departments are bound to.
  'org:bindings:read',
  'org:units:read',
  'org:seats:read',
  'org:profile:read',
] as const;

/**
 * Expand a system org role into its concrete `subject:action` key set (the seed
 * for `RolePermission` of the org system role). `platform_owner`/`platform_admin`
 * → the full vocabulary; `employee` → the read-only structure view.
 */
export function expandSystemOrgRolePermissions(role: SystemOrgRoleKey): PermissionKey[] {
  if (role === 'employee') return [...EMPLOYEE_ORG_KEYS].sort();
  // owner & admin: full vocabulary (matches the old orgRoleCanManage carve).
  return [...ORG_STRUCTURE_KEYS].sort();
}

/**
 * Expanded permission-sets of all three system org roles. Used by the control
 * seed (`ensureSystemOrgRoles`) to materialize the immutable rows.
 */
export function expandAllSystemOrgRoles(): Record<SystemOrgRoleKey, PermissionKey[]> {
  return {
    platform_owner: expandSystemOrgRolePermissions('platform_owner'),
    platform_admin: expandSystemOrgRolePermissions('platform_admin'),
    employee: expandSystemOrgRolePermissions('employee'),
  };
}
