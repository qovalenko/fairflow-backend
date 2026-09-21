import {
  MODULE_REGISTRY,
  type ModuleDefinition,
  type ProjectModuleConfig,
} from './module-registry';
import type { ModuleRuntimeStatus } from './module-gating';

export type ModuleConfigState = 'ready' | 'needs_config';
export type DlqResumeFate = 'discard' | 'deliver';

/** Whether all manifest `requiredBeforeEnable` keys are present and non-empty. */
export function hasRequiredSettings(
  def: ModuleDefinition,
  cfg: ProjectModuleConfig,
): boolean {
  const required = def.requiredBeforeEnable ?? [];
  if (required.length === 0) return true;
  const integration = cfg.integrationSettings ?? {};
  const personal = cfg.personalSettings ?? {};
  return required.every((key) => {
    const value = integration[key] ?? personal[key];
    if (value == null) return false;
    if (typeof value === 'string') return value.trim().length > 0;
    if (Array.isArray(value)) return value.length > 0;
    return true;
  });
}

export function computeConfigState(
  def: ModuleDefinition,
  cfg: ProjectModuleConfig,
): ModuleConfigState {
  return hasRequiredSettings(def, cfg) ? 'ready' : 'needs_config';
}

export function readRuntimeStatus(cfg: ProjectModuleConfig): ModuleRuntimeStatus {
  if (cfg.configState === 'needs_config') return 'suspended';
  if (cfg.runtimeStatus === 'suspended') return 'suspended';
  if (cfg.runtimeStatus === 'active') return 'active';
  return cfg.enabled ? 'active' : 'suspended';
}

/** Disable transition (FR-LIFE-17 / FR-PLATFORM-115). */
export function applyDisableRuntime(cfg: ProjectModuleConfig): ProjectModuleConfig {
  return {
    ...cfg,
    runtimeStatus: 'suspended',
    everSuspended: true,
  };
}

/**
 * Enable transition (FR-LIFE-16 / FR-PLATFORM-115, FR-LIFE-22 / FR-PLATFORM-230).
 * Re-enable after suspend keeps runtime frozen until explicit resume-delivery.
 */
export function applyEnableRuntime(
  prev: ProjectModuleConfig | undefined,
  cfg: ProjectModuleConfig,
  def: ModuleDefinition,
): ProjectModuleConfig {
  const everSuspended = prev?.everSuspended === true;
  const configState = computeConfigState(def, cfg);
  const runtimeStatus: ModuleRuntimeStatus =
    everSuspended || configState === 'needs_config' ? 'suspended' : 'active';
  return {
    ...cfg,
    configState,
    everSuspended,
    runtimeStatus,
  };
}

/** Settings-only refresh while the module stays enabled. */
export function refreshEnabledRuntimeState(
  prev: ProjectModuleConfig | undefined,
  cfg: ProjectModuleConfig,
  def: ModuleDefinition,
): ProjectModuleConfig {
  const configState = computeConfigState(def, cfg);
  const everSuspended = prev?.everSuspended === true || cfg.everSuspended === true;
  let runtimeStatus = readRuntimeStatus(cfg);

  if (configState === 'needs_config') {
    runtimeStatus = 'suspended';
  } else if (
    configState === 'ready' &&
    !everSuspended &&
    prev?.configState === 'needs_config' &&
    runtimeStatus === 'suspended'
  ) {
    runtimeStatus = 'active';
  }

  return {
    ...cfg,
    configState,
    everSuspended,
    runtimeStatus,
  };
}

/** Explicit resume-delivery (FR-LIFE-28 / FR-PLATFORM-115). */
export function applyResumeDelivery(cfg: ProjectModuleConfig): ProjectModuleConfig {
  if (!cfg.enabled) {
    throw new Error('MODULE_DISABLED');
  }
  if ((cfg.configState ?? 'ready') === 'needs_config') {
    throw new Error('MODULE_NEEDS_CONFIG');
  }
  if (readRuntimeStatus(cfg) === 'active') {
    return { ...cfg, runtimeStatus: 'active' };
  }
  return {
    ...cfg,
    runtimeStatus: 'active',
  };
}

/**
 * Apply runtime-axis transitions after `normalizeModuleConfigs` based on
 * enable/disable edges and settings completeness.
 */
export function syncModuleRuntimeAxes(
  prevConfigs: ProjectModuleConfig[],
  nextConfigs: ProjectModuleConfig[],
): ProjectModuleConfig[] {
  const prevById = new Map(prevConfigs.map((c) => [c.moduleId, c]));
  const prevEnabled = new Set(prevConfigs.filter((c) => c.enabled).map((c) => c.moduleId));

  return nextConfigs.map((cfg) => {
    const def = MODULE_REGISTRY[cfg.moduleId];
    if (!def) return cfg;
    const prev = prevById.get(cfg.moduleId);
    const wasEnabled = prevEnabled.has(cfg.moduleId);
    const isEnabled = cfg.enabled;

    if (!wasEnabled && isEnabled) {
      return applyEnableRuntime(prev, cfg, def);
    }
    if (wasEnabled && !isEnabled) {
      return applyDisableRuntime(cfg);
    }
    if (isEnabled) {
      return refreshEnabledRuntimeState(prev, cfg, def);
    }

    return {
      ...cfg,
      runtimeStatus: cfg.runtimeStatus ?? prev?.runtimeStatus ?? 'suspended',
      everSuspended: cfg.everSuspended ?? prev?.everSuspended ?? false,
      configState: cfg.configState ?? prev?.configState ?? 'ready',
    };
  });
}
