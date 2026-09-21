/**
 * Read-only module contract validator (FR-STAT-030 / FR-MSTAT-3).
 *
 * Modules like `statistics` are analytics-only: no owned data subjects and no
 * mutating permissions. The manifest MUST declare `dataSubjects: []` and only
 * `{read, export}` (+ namespace-scoped read like `statistics.widget:read`).
 * Attempts to declare `write` / `delete` / `manage` fail closed at registry
 * ingest — same posture as `validatePartnerManifest`.
 */

import type { ModuleManifestV1 } from './module-manifest';

/** Registry ids that MUST stay read-only by contract (FR-STAT-030). */
export const READ_ONLY_MODULE_IDS = ['statistics'] as const;

export type ReadOnlyModuleId = (typeof READ_ONLY_MODULE_IDS)[number];

const FORBIDDEN_MUTATING_ACTIONS = new Set(['write', 'delete', 'manage']);

/** Allowed action vocabulary for read-only modules (FR-MSTAT-3). */
const ALLOWED_READ_ONLY_ACTIONS = new Set(['read', 'export']);

export type ReadOnlyModuleViolationCode =
  | 'NOT_READ_ONLY_MODULE'
  | 'DATASUBJECTS_NON_EMPTY'
  | 'FORBIDDEN_MUTATING_ACTION'
  | 'UNKNOWN_ACTION';

export interface ReadOnlyModuleViolation {
  code: ReadOnlyModuleViolationCode;
  message: string;
  value?: string;
}

export interface ReadOnlyModuleValidationResult {
  ok: boolean;
  violations: ReadOnlyModuleViolation[];
}

export function isReadOnlyModuleId(id: string): id is ReadOnlyModuleId {
  return (READ_ONLY_MODULE_IDS as readonly string[]).includes(id);
}

/**
 * Validate that a manifest satisfies the read-only module contract.
 * Non read-only ids return `{ ok: true }` — caller may iterate all manifests.
 */
export function validateReadOnlyModule(manifest: ModuleManifestV1): ReadOnlyModuleValidationResult {
  if (!isReadOnlyModuleId(manifest.id)) {
    return { ok: true, violations: [] };
  }

  const violations: ReadOnlyModuleViolation[] = [];

  const subjects = manifest.dataSubjects ?? [];
  if (subjects.length > 0) {
    violations.push({
      code: 'DATASUBJECTS_NON_EMPTY',
      message: `read-only module "${manifest.id}" MUST declare dataSubjects: []`,
      value: subjects.map((s) => s.resource).join(','),
    });
  }

  for (const perm of manifest.permissions ?? []) {
    for (const action of perm.actions) {
      if (FORBIDDEN_MUTATING_ACTIONS.has(action)) {
        violations.push({
          code: 'FORBIDDEN_MUTATING_ACTION',
          message: `read-only module "${manifest.id}" MUST NOT declare ${action} on ${perm.subject}`,
          value: `${perm.subject}:${action}`,
        });
      } else if (!ALLOWED_READ_ONLY_ACTIONS.has(action)) {
        violations.push({
          code: 'UNKNOWN_ACTION',
          message: `read-only module "${manifest.id}" allows only read/export actions (got ${action} on ${perm.subject})`,
          value: `${perm.subject}:${action}`,
        });
      }
    }
  }

  return { ok: violations.length === 0, violations };
}

/** Fail-closed assert for build-time / registry checks. */
export function assertReadOnlyModules(manifests: Record<string, ModuleManifestV1>): void {
  for (const id of READ_ONLY_MODULE_IDS) {
    const manifest = manifests[id];
    if (!manifest) {
      throw new Error(`read-only module "${id}" missing from MODULE_MANIFESTS`);
    }
    const { ok, violations } = validateReadOnlyModule(manifest);
    if (!ok) {
      const detail = violations.map((v) => v.message).join('; ');
      throw new Error(`read-only module contract violated (${id}): ${detail}`);
    }
  }
}
