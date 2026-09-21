import {
  extractEnabledModulesFromConfigs,
  resolveDependencies,
  type ProjectModuleConfig,
} from './module-registry';

/**
 * Contextual-UI / soft-disable enforcement (R4-E1-07, module-lifecycle §6.1, §19e.5).
 *
 * Invariant: when a module is DISABLED in a project, its contribution is NOT
 * active, but its data is PRESERVED:
 *  (a) custom fields / entities of the module are not applied / validated;
 *  (b) its event listeners / emits do not fire;
 *  (c) its automation triggers are frozen.
 * Nothing in this module deletes data — re-enable restores the contribution.
 *
 * This file is the SINGLE SOURCE of "effective enabled modules" used by every
 * runtime check point (gateway resolution + domain enforcement). It composes the
 * two orthogonal lifecycle axes from `ProjectModuleConfig` (module-lifecycle §3,
 * §7.4):
 *  - `enabled`       → UI/data contribution (fields, entities, data writes).
 *  - `runtimeStatus` → external delivery + automation/event runtime (§19e.5).
 *
 * `runtimeStatus` is additive/optional on `ProjectModuleConfig` (not yet a stored
 * column — R4-E1-05 added `installed`/`version` only). Until it is persisted the
 * runtime axis is DERIVED from `enabled`: an enabled module is runtime-active, a
 * disabled module is frozen. When the field is present it wins (a module can be
 * `enabled:true, runtimeStatus:suspended` — visible, delivery frozen).
 */

export type ModuleRuntimeStatus = 'active' | 'suspended';

/** Per-module effective projection consumed by every enforcement point. */
export type EffectiveModuleProjection = {
  moduleId: string;
  /** Effective-enabled (dependency-resolved, locked-forced). */
  enabled: boolean;
  /** May the module contribute fields/entities/data writes? (== enabled). */
  contributing: boolean;
  /** May the module's events/automation run? (enabled AND not suspended). */
  runtimeActive: boolean;
};

/** Error thrown when a write/contribution targets a disabled module. */
export const MODULE_GATING_ERROR = {
  CONTRIBUTION_DISABLED: 'MODULE_CONTRIBUTION_DISABLED',
  RUNTIME_FROZEN: 'MODULE_RUNTIME_FROZEN',
} as const;
export type ModuleGatingErrorCode =
  (typeof MODULE_GATING_ERROR)[keyof typeof MODULE_GATING_ERROR];

export class ModuleGatingError extends Error {
  constructor(
    public readonly code: ModuleGatingErrorCode,
    message: string,
    public readonly moduleId: string,
  ) {
    super(message);
    this.name = 'ModuleGatingError';
  }
}

function readRuntimeStatus(cfg: ProjectModuleConfig): ModuleRuntimeStatus {
  if (cfg.configState === 'needs_config') return 'suspended';
  if (cfg.runtimeStatus === 'suspended') return 'suspended';
  if (cfg.runtimeStatus === 'active') return 'active';
  return cfg.enabled ? 'active' : 'suspended';
}

/**
 * Canonical effective projection of a project's modules. The set of CONTRIBUTING
 * modules is exactly `extractEnabledModulesFromConfigs` (dependency-resolved,
 * locked-forced) — the same source the catalog (E1-02) and nav-cards (E1-08)
 * already use, so runtime gating cannot drift from the UI projection.
 */
export function computeEffectiveModuleProjection(
  configs: ProjectModuleConfig[] | undefined,
): EffectiveModuleProjection[] {
  const list = Array.isArray(configs) ? configs : [];
  const effectiveEnabled = new Set(extractEnabledModulesFromConfigs(list));
  const statusById = new Map<string, ModuleRuntimeStatus>(
    list.map((c) => [c.moduleId, readRuntimeStatus(c)]),
  );
  // Union of configured modules + everything pulled in by dependency resolution.
  const ids = new Set<string>(list.map((c) => c.moduleId));
  for (const id of effectiveEnabled) ids.add(id);
  return Array.from(ids).map((moduleId) => {
    const enabled = effectiveEnabled.has(moduleId);
    const runtimeActive = enabled && (statusById.get(moduleId) ?? 'active') === 'active';
    return { moduleId, enabled, contributing: enabled, runtimeActive };
  });
}

/** Effective-enabled module ids (single source for `x-enabled-modules`). */
export function computeEffectiveEnabledModules(
  configs: ProjectModuleConfig[] | undefined,
): string[] {
  return extractEnabledModulesFromConfigs(Array.isArray(configs) ? configs : []);
}

/** Module ids whose runtime (events/automation) is active for the project. */
export function computeRuntimeActiveModules(
  configs: ProjectModuleConfig[] | undefined,
): string[] {
  return computeEffectiveModuleProjection(configs)
    .filter((p) => p.runtimeActive)
    .map((p) => p.moduleId);
}

/** (a) May the module contribute fields/entities/writes for this project? */
export function isModuleContributing(
  configs: ProjectModuleConfig[] | undefined,
  moduleId: string,
): boolean {
  return computeEffectiveEnabledModules(configs).includes(moduleId);
}

/** (b)/(c) May the module emit/listen events and fire automation triggers? */
export function isModuleRuntimeActive(
  configs: ProjectModuleConfig[] | undefined,
  moduleId: string,
): boolean {
  return computeEffectiveModuleProjection(configs).some(
    (p) => p.moduleId === moduleId && p.runtimeActive,
  );
}

/** Throwing guard for write/contribution input points (data is never touched). */
export function assertModuleContributing(
  configs: ProjectModuleConfig[] | undefined,
  moduleId: string,
): void {
  if (!isModuleContributing(configs, moduleId)) {
    throw new ModuleGatingError(
      MODULE_GATING_ERROR.CONTRIBUTION_DISABLED,
      `Module "${moduleId}" is disabled for this project; contribution is inert (data preserved)`,
      moduleId,
    );
  }
}

/**
 * Runtime gating from the propagated `x-enabled-modules` metadata (the effective
 * set the gateway already resolved). Event emit / listener / automation-trigger
 * sites call this: a frozen module's runtime is skipped silently (data untouched).
 *
 * When the metadata is absent (internal s2s caller that did not pass through the
 * gateway resolution) the call is NOT blocked — matching `ModuleGuard`'s
 * fail-open-on-absent contract; enforcement happens where the gateway resolved
 * the effective set.
 */
export function isModuleRuntimeAllowedByMetadata(
  enabledModules: string[] | undefined,
  moduleId: string,
): boolean {
  if (!enabledModules) return true;
  return enabledModules.includes(moduleId);
}

/** Parse the `x-enabled-modules` JSON payload (undefined on absent/malformed). */
export function parseEnabledModulesHeader(raw: unknown): string[] | undefined {
  if (typeof raw !== 'string' || raw.length === 0) return undefined;
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed.filter((m): m is string => typeof m === 'string');
  } catch {
    return undefined;
  }
  return undefined;
}

/**
 * Filter a list of module-owned event emissions to only those whose owning
 * module's runtime is active for the project (FR-LIFE-17: disabled module's
 * emits do not fire). Used by emit sites that batch several module events.
 */
export function gateModuleEmissions<T extends { moduleId: string }>(
  enabledModules: string[] | undefined,
  emissions: T[],
): T[] {
  if (!enabledModules) return emissions;
  return emissions.filter((e) => enabledModules.includes(e.moduleId));
}

// Re-export the dependency resolver so enforcement sites import one place.
export { resolveDependencies };
