/**
 * Module lifecycle (R4-E1-05) — pure, storage-agnostic state machine and
 * version helpers that sit ON TOP of the existing enable/disable mechanics
 * (`normalizeModuleConfigs` in `module-registry.ts`). This file owns the
 * *transition rules and invariants* of the per-project module lifecycle:
 *
 *   not_installed → installed → enabled ⇄ disabled → uninstalled
 *
 * plus version upgrade (`upgrade`) keyed off `ModuleManifestV1.version`, with a
 * migration-on-demand hook skeleton (FR-LIFE-25): migrations run only when the
 * target version declares migration steps AND the module has data in the
 * project (the actual per-domain data migration is out of scope here — only
 * the framework/dry-run is provided).
 *
 * Source: docs/tz/areas/module-lifecycle/TZ.md (§4.3/§4.4/§4.6/§7), RFC-2.
 *
 * Design notes:
 * - This module performs NO IO. control wires it to the project store.
 * - It re-uses the manifest (`moduleDefinitionToManifest` / MODULE_REGISTRY) as
 *   the source of truth for version / kind / dependencies / alwaysEnabled.
 * - enable/disable are NOT re-implemented; `applyEnable`/`applyDisable` here are
 *   thin invariant-checked wrappers that the control service composes with the
 *   existing `normalizeModuleConfigs` projection.
 */

import { MODULE_REGISTRY, type ModuleDefinition } from './module-registry';
import { moduleDefinitionToManifest, type ModuleManifestV1 } from './module-manifest';
import { getModuleManifest } from './module-manifests';

/**
 * Lifecycle state of a module *within a project*. `enabled`/`disabled` are
 * UI-visibility states (AS-IS, via `ProjectModuleConfig.enabled`); `installed`
 * is "present in the space but not enabled in this project"; `uninstalled` /
 * `not_installed` mean no install record.
 */
export type ModuleLifecycleState =
  | 'not_installed'
  | 'installed'
  | 'enabled'
  | 'disabled'
  | 'uninstalled';

export type ModuleLifecycleAction =
  | 'install'
  | 'enable'
  | 'disable'
  | 'upgrade'
  | 'uninstall';

export type UpgradeClass = 'patch' | 'minor' | 'major' | 'none';

export const LIFECYCLE_ERROR = {
  MODULE_UNKNOWN: 'MODULE_UNKNOWN',
  MODULE_NOT_INSTALLED: 'MODULE_NOT_INSTALLED',
  ALREADY_INSTALLED: 'ALREADY_INSTALLED',
  DEPENDENCY_NOT_INSTALLED: 'DEPENDENCY_NOT_INSTALLED',
  DEPENDENTS_ENABLED: 'DEPENDENTS_ENABLED',
  SYSTEM_MODULE_IMMUTABLE: 'SYSTEM_MODULE_IMMUTABLE',
  MODULE_ENABLED_IN_PROJECTS: 'MODULE_ENABLED_IN_PROJECTS',
  MODULE_LOCKED: 'MODULE_LOCKED',
  VERSION_UNKNOWN: 'VERSION_UNKNOWN',
  VERSION_NOT_NEWER: 'VERSION_NOT_NEWER',
  MIGRATION_REQUIRED: 'MIGRATION_REQUIRED',
  INVALID_TRANSITION: 'INVALID_TRANSITION',
} as const;

export type LifecycleErrorCode =
  (typeof LIFECYCLE_ERROR)[keyof typeof LIFECYCLE_ERROR];

export class ModuleLifecycleError extends Error {
  readonly code: LifecycleErrorCode;
  readonly details?: Record<string, unknown>;
  constructor(code: LifecycleErrorCode, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = 'ModuleLifecycleError';
    this.code = code;
    this.details = details;
    // Same as AppError: without this, `instanceof` can fail across TS/CJS
    // compile units and two copies of @fairflow/shared — mapError then
    // rethrows and RpcAppExceptionFilter masks it as "Internal error".
    Object.setPrototypeOf(this, ModuleLifecycleError.prototype);
  }
}

// ─── semver helpers (small, dependency-free) ────────────────────────────────

export type SemVer = { major: number; minor: number; patch: number };

/** Parse a `x.y.z` semver into parts; tolerant of a leading `v` and a `-pre` suffix. */
export function parseSemVer(version: string): SemVer | null {
  if (typeof version !== 'string') return null;
  const cleaned = version.trim().replace(/^v/, '').split(/[-+]/)[0];
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(cleaned);
  if (!m) return null;
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]) };
}

/** -1 / 0 / 1 compare; treats unparsable versions as 0.0.0. */
export function compareSemVer(a: string, b: string): number {
  const pa = parseSemVer(a) ?? { major: 0, minor: 0, patch: 0 };
  const pb = parseSemVer(b) ?? { major: 0, minor: 0, patch: 0 };
  if (pa.major !== pb.major) return pa.major < pb.major ? -1 : 1;
  if (pa.minor !== pb.minor) return pa.minor < pb.minor ? -1 : 1;
  if (pa.patch !== pb.patch) return pa.patch < pb.patch ? -1 : 1;
  return 0;
}

/**
 * Classify an upgrade from `fromVersion` to `toVersion` (FR-LIFE-23).
 * `none` when equal/downgrade; `major`/`minor`/`patch` for forward bumps.
 */
export function classifyUpgrade(fromVersion: string, toVersion: string): UpgradeClass {
  const from = parseSemVer(fromVersion);
  const to = parseSemVer(toVersion);
  if (!from || !to) return 'none';
  if (compareSemVer(toVersion, fromVersion) <= 0) return 'none';
  if (to.major !== from.major) return 'major';
  if (to.minor !== from.minor) return 'minor';
  return 'patch';
}

// ─── manifest accessors (version / kind / locked / deps) ────────────────────

function defOf(moduleId: string): ModuleDefinition {
  const def = MODULE_REGISTRY[moduleId];
  if (!def) {
    throw new ModuleLifecycleError(
      LIFECYCLE_ERROR.MODULE_UNKNOWN,
      `Unknown module: ${moduleId}`,
      { moduleId },
    );
  }
  return def;
}

/**
 * Authoritative manifest for a module — the real `ModuleManifestV1`
 * (`module-manifests.ts`) when present, else the legacy bridge. version / kind /
 * locked / deps now read from the REAL manifest (I2a), so the lifecycle reflects
 * each module's declared version & grammar rather than synthesized defaults.
 */
function manifestOf(moduleId: string): ModuleManifestV1 {
  return getModuleManifest(moduleId) ?? moduleDefinitionToManifest(defOf(moduleId));
}

/** Manifest-declared version of a module (`ModuleManifestV1.version`). */
export function getModuleVersion(moduleId: string): string {
  defOf(moduleId);
  return manifestOf(moduleId).version;
}

/** Manifest kind: `system | business | partner`. */
export function getModuleKind(moduleId: string): 'system' | 'business' | 'partner' {
  defOf(moduleId);
  return manifestOf(moduleId).kind;
}

/**
 * Non-removability flag derived per RFC-2: `alwaysEnabled || kind==='system'`.
 * `locked` is NEVER declared in the manifest — it is computed here.
 */
export function isModuleLocked(moduleId: string): boolean {
  const manifest = manifestOf(moduleId);
  return Boolean(manifest.alwaysEnabled) || manifest.kind === 'system';
}

/** Direct hard dependencies of a module (manifest `dependsOn`). */
export function getModuleDependencies(moduleId: string): string[] {
  defOf(moduleId);
  return manifestOf(moduleId).dependsOn ?? [];
}

// ─── migration-on-demand skeleton (FR-LIFE-25) ──────────────────────────────

/** A declared migration step for a module version (skeleton — no domain logic). */
export type ModuleMigrationStep = {
  fromMajor: number;
  toMajor: number;
  /** Opaque reference resolved by the owning domain at run time. */
  scriptRef: string;
  reversible?: boolean;
};

/**
 * Whether an upgrade needs a data migration *on demand* (FR-LIFE-25): a
 * migration is required only when the upgrade crosses a major boundary AND the
 * target version declares a matching migration step. minor/patch never migrate.
 *
 * Returns the matching steps (empty = no migration needed). The caller (control)
 * additionally gates on "the project actually has data" before invoking the
 * domain `RunMigrations` hook — migrations do not run on every upgrade.
 */
export function resolveRequiredMigrations(
  fromVersion: string,
  toVersion: string,
  declaredSteps: ModuleMigrationStep[] | undefined,
): ModuleMigrationStep[] {
  if (classifyUpgrade(fromVersion, toVersion) !== 'major') return [];
  const from = parseSemVer(fromVersion);
  const to = parseSemVer(toVersion);
  if (!from || !to || !Array.isArray(declaredSteps)) return [];
  // Every major hop in (from.major, to.major] must have a declared step.
  const steps: ModuleMigrationStep[] = [];
  for (let major = from.major + 1; major <= to.major; major++) {
    const step = declaredSteps.find((s) => s.toMajor === major);
    if (step) steps.push(step);
  }
  return steps;
}

// ─── transition validation (invariants §7.5) ────────────────────────────────

/** Context the validators need from the project store. */
export type LifecycleContext = {
  /** moduleId → whether installed in the owning space. */
  installed: Set<string>;
  /** moduleId → whether enabled in this project. */
  enabled: Set<string>;
};

/** Current lifecycle state of one module given the context. */
export function lifecycleStateOf(moduleId: string, ctx: LifecycleContext): ModuleLifecycleState {
  if (!ctx.installed.has(moduleId)) return 'not_installed';
  if (ctx.enabled.has(moduleId)) return 'enabled';
  return 'installed';
}

/** Modules that hard-depend on `moduleId` AND are currently enabled. */
export function enabledDependentsOf(moduleId: string, ctx: LifecycleContext): string[] {
  const dependents: string[] = [];
  for (const id of ctx.enabled) {
    if (id === moduleId) continue;
    if (getModuleDependencies(id).includes(moduleId)) dependents.push(id);
  }
  return dependents.sort();
}

/**
 * Validate `install` (FR-LIFE-8/14): module must exist; idempotent if already
 * installed (caller decides no-op vs error — we surface `ALREADY_INSTALLED`
 * only as info via the returned flag).
 */
export function assertCanInstall(moduleId: string, ctx: LifecycleContext): { alreadyInstalled: boolean } {
  defOf(moduleId);
  return { alreadyInstalled: ctx.installed.has(moduleId) };
}

/**
 * Validate `enable` (FR-LIFE-14/15): requires the module AND all hard
 * dependencies to be installed; `kind:system` dependencies are always satisfied
 * (virtual install, FR-LIFE-9).
 */
export function assertCanEnable(moduleId: string, ctx: LifecycleContext): void {
  defOf(moduleId);
  if (!ctx.installed.has(moduleId)) {
    throw new ModuleLifecycleError(
      LIFECYCLE_ERROR.MODULE_NOT_INSTALLED,
      `Module ${moduleId} is not installed in the space`,
      { moduleId },
    );
  }
  for (const dep of getModuleDependencies(moduleId)) {
    if (getModuleKind(dep) === 'system') continue; // virtually installed
    if (!ctx.installed.has(dep)) {
      throw new ModuleLifecycleError(
        LIFECYCLE_ERROR.DEPENDENCY_NOT_INSTALLED,
        `Dependency ${dep} of ${moduleId} is not installed`,
        { moduleId, dependency: dep },
      );
    }
  }
}

/**
 * Validate `disable` (FR-LIFE-19/20): system/locked modules cannot be disabled;
 * enabled dependents block the disable unless `cascade:true` (no silent cascade).
 */
export function assertCanDisable(
  moduleId: string,
  ctx: LifecycleContext,
  opts?: { cascade?: boolean },
): { cascadeTargets: string[] } {
  defOf(moduleId);
  if (isModuleLocked(moduleId)) {
    throw new ModuleLifecycleError(
      LIFECYCLE_ERROR.SYSTEM_MODULE_IMMUTABLE,
      `Module ${moduleId} is locked (system/alwaysEnabled) and cannot be disabled`,
      { moduleId },
    );
  }
  const dependents = enabledDependentsOf(moduleId, ctx);
  if (dependents.length > 0 && !opts?.cascade) {
    throw new ModuleLifecycleError(
      LIFECYCLE_ERROR.DEPENDENTS_ENABLED,
      `Enabled modules depend on ${moduleId}: ${dependents.join(', ')}`,
      { moduleId, dependents },
    );
  }
  return { cascadeTargets: dependents };
}

/**
 * Validate `uninstall` (FR-LIFE-11/20): system/locked cannot be uninstalled;
 * blocked while enabled in the project (deny `MODULE_ENABLED_IN_PROJECTS`).
 */
export function assertCanUninstall(moduleId: string, ctx: LifecycleContext): void {
  defOf(moduleId);
  if (isModuleLocked(moduleId)) {
    throw new ModuleLifecycleError(
      LIFECYCLE_ERROR.SYSTEM_MODULE_IMMUTABLE,
      `Module ${moduleId} is locked (system/alwaysEnabled) and cannot be uninstalled`,
      { moduleId },
    );
  }
  if (!ctx.installed.has(moduleId)) {
    throw new ModuleLifecycleError(
      LIFECYCLE_ERROR.MODULE_NOT_INSTALLED,
      `Module ${moduleId} is not installed`,
      { moduleId },
    );
  }
  if (ctx.enabled.has(moduleId)) {
    throw new ModuleLifecycleError(
      LIFECYCLE_ERROR.MODULE_ENABLED_IN_PROJECTS,
      `Module ${moduleId} must be disabled before uninstall`,
      { moduleId },
    );
  }
}

export type UpgradePreview = {
  moduleId: string;
  fromVersion: string;
  toVersion: string;
  upgradeClass: UpgradeClass;
  requiresConfirmation: boolean;
  migrations: ModuleMigrationStep[];
  migrationRequired: boolean;
};

/**
 * Validate + describe an `upgrade` (FR-LIFE-23/25). Throws when target is not
 * newer or when a major upgrade lacks a declared migration. major upgrades
 * require explicit confirmation (`requiresConfirmation`).
 */
export function previewUpgrade(
  moduleId: string,
  fromVersion: string,
  toVersion: string,
  declaredSteps?: ModuleMigrationStep[],
): UpgradePreview {
  defOf(moduleId);
  if (!parseSemVer(toVersion)) {
    throw new ModuleLifecycleError(
      LIFECYCLE_ERROR.VERSION_UNKNOWN,
      `Invalid target version: ${toVersion}`,
      { moduleId, toVersion },
    );
  }
  const upgradeClass = classifyUpgrade(fromVersion, toVersion);
  if (upgradeClass === 'none') {
    throw new ModuleLifecycleError(
      LIFECYCLE_ERROR.VERSION_NOT_NEWER,
      `Target version ${toVersion} is not newer than ${fromVersion}`,
      { moduleId, fromVersion, toVersion },
    );
  }
  const migrations = resolveRequiredMigrations(fromVersion, toVersion, declaredSteps);
  // major-upgrade across a major with NO declared step → MIGRATION_REQUIRED.
  if (upgradeClass === 'major') {
    const from = parseSemVer(fromVersion)!;
    const to = parseSemVer(toVersion)!;
    const declared = Array.isArray(declaredSteps) ? declaredSteps : [];
    for (let major = from.major + 1; major <= to.major; major++) {
      if (!declared.some((s) => s.toMajor === major)) {
        throw new ModuleLifecycleError(
          LIFECYCLE_ERROR.MIGRATION_REQUIRED,
          `Major upgrade of ${moduleId} to ${toVersion} requires a migration to major ${major}`,
          { moduleId, fromVersion, toVersion, missingMajor: major },
        );
      }
    }
  }
  return {
    moduleId,
    fromVersion,
    toVersion,
    upgradeClass,
    requiresConfirmation: upgradeClass === 'major',
    migrations,
    migrationRequired: migrations.length > 0,
  };
}
