/**
 * Permission catalog generator (FR-MOD-17 / US-MOD-2).
 *
 * Source of truth: docs/tz/areas/module-contract/TZ.md §FR-MOD-17 (line 228) +
 * contracts/control.md (`GetPermissionCatalog` / `PermissionCatalog`).
 *
 * "control строит каталог `{subject, actions[]}` как union `permissions[]`
 * установленных и эффективно включённых манифестов. Захардкоженного каталога
 * нет; gateway/host получают каталог из control."
 *
 * This module is the single place that turns a set of `ModuleManifestV1` into a
 * normalized, machine-readable permission registry (`subject:action`) for
 * control / the catalog endpoint. It replaces hand-written permission listings:
 * the legacy `validatePolicyRules` (module-registry.ts) now validates through the
 * catalog built from manifests (via `moduleDefinitionToManifest`) instead of
 * reading `ModuleDefinition.policyCapabilities` directly.
 *
 * Additive: no behavioural change to the legacy registry — the catalog built
 * from `MODULE_REGISTRY` projected through `moduleDefinitionToManifest` is, by
 * construction, the union of every module's `policyCapabilities`.
 */

import type { PermissionAction } from './rbac';
import {
  type ModuleManifestV1,
  type ManifestPermission,
  isWithinNamespace,
  normalizeAction,
} from './module-manifest';

/**
 * Canonical `subject:action` permission key, e.g. `deals:read`,
 * `documents.generate:execute`. This is the atomic unit roles/policy rules
 * reference (precondition for E2-01 custom roles in the DB).
 */
export type PermissionKey = `${string}:${PermissionAction}`;

/**
 * Synthetic module id carrying the engine's project-level system subjects
 * (`roles`, `project`, `members`) — FR-PERM-24. Declared here (not in
 * permission-rbac.ts) so the catalog builder can recognize it without a circular
 * import; permission-rbac.ts re-uses this constant. Its subjects are, by design,
 * bare (`roles`, not `core.roles`) because they are project-wide system subjects,
 * so they are exempted from the module namespace filter in `collectFromManifest`.
 */
export const SYSTEM_PERMISSION_MODULE_ID = 'core';

/** Build the `subject:action` key (single source of the encoding). */
export function permissionKey(subject: string, action: PermissionAction): PermissionKey {
  return `${subject}:${action}` as PermissionKey;
}

/** Parse a `subject:action` key back into its parts (last `:` separates action). */
export function parsePermissionKey(
  key: string,
): { subject: string; action: string } | null {
  const idx = key.lastIndexOf(':');
  if (idx <= 0 || idx === key.length - 1) return null;
  return { subject: key.slice(0, idx), action: key.slice(idx + 1) };
}

/** One catalog entry: a subject and the set of actions allowed on it. */
export interface PermissionCatalogEntry {
  subject: string;
  actions: PermissionAction[];
  /** Module ids that contribute this subject (provenance / debugging). */
  moduleIds: string[];
}

/**
 * Normalized permission catalog: the `action × subject` matrix derived from a
 * set of manifests. `keys` is the flat `subject:action` registry; `entries` is
 * the grouped `{subject, actions[]}` view; `has()` answers membership in O(1).
 */
export interface PermissionCatalog {
  /** Grouped `{subject, actions[]}` view, stable-sorted by subject. */
  entries: PermissionCatalogEntry[];
  /** Flat, sorted, de-duplicated `subject:action` registry. */
  keys: PermissionKey[];
  /** Membership test for a `subject:action` pair. */
  has(subject: string, action: string): boolean;
  /** Membership test for a pre-built `subject:action` key. */
  hasKey(key: string): boolean;
}

/**
 * Validate that a manifest permission's subject lies in the module namespace
 * (FR-MOD-26a) and that its actions are canonical. Out-of-namespace subjects are
 * dropped here (the AJV manifest validator rejects them at install; this is a
 * defensive build-time guard so a bad manifest cannot widen the catalog).
 */
function collectFromManifest(
  manifest: ModuleManifestV1,
  bySubject: Map<string, { actions: Set<PermissionAction>; moduleIds: Set<string> }>,
): void {
  const permissions: ManifestPermission[] = manifest.permissions ?? [];
  // The system module (`core`) carries project-wide system subjects (`roles`,
  // `project`, `members`) that intentionally live outside any module namespace
  // (FR-PERM-24); exempt it from the namespace filter so its subjects reach the
  // catalog. Business modules stay strictly namespace-guarded (FR-MOD-26a).
  const enforceNamespace = manifest.id !== SYSTEM_PERMISSION_MODULE_ID;
  for (const perm of permissions) {
    if (enforceNamespace && !isWithinNamespace(perm.subject, manifest.id)) continue;
    let entry = bySubject.get(perm.subject);
    if (!entry) {
      entry = { actions: new Set(), moduleIds: new Set() };
      bySubject.set(perm.subject, entry);
    }
    entry.moduleIds.add(manifest.id);
    for (const rawAction of perm.actions) {
      entry.actions.add(normalizeAction(rawAction) as PermissionAction);
    }
  }
}

/**
 * Build the normalized permission catalog as the union of `permissions[]` over
 * the given manifests (FR-MOD-17). Subjects/actions are de-duplicated; the
 * result is deterministic (sorted) so it is diff-stable for seeds/snapshots.
 */
export function buildPermissionCatalog(manifests: ModuleManifestV1[]): PermissionCatalog {
  const bySubject = new Map<
    string,
    { actions: Set<PermissionAction>; moduleIds: Set<string> }
  >();
  for (const manifest of manifests) collectFromManifest(manifest, bySubject);

  const entries: PermissionCatalogEntry[] = Array.from(bySubject.entries())
    .map(([subject, { actions, moduleIds }]) => ({
      subject,
      actions: Array.from(actions).sort(),
      moduleIds: Array.from(moduleIds).sort(),
    }))
    .sort((a, b) => a.subject.localeCompare(b.subject));

  const keySet = new Set<PermissionKey>();
  for (const entry of entries) {
    for (const action of entry.actions) keySet.add(permissionKey(entry.subject, action));
  }
  const keys = Array.from(keySet).sort();

  return {
    entries,
    keys,
    has(subject: string, action: string): boolean {
      return keySet.has(`${subject}:${action}` as PermissionKey);
    },
    hasKey(key: string): boolean {
      return keySet.has(key as PermissionKey);
    },
  };
}
