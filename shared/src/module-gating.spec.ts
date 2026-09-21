import {
  computeEffectiveModuleProjection,
  computeEffectiveEnabledModules,
  computeRuntimeActiveModules,
  isModuleContributing,
  isModuleRuntimeActive,
  assertModuleContributing,
  isModuleRuntimeAllowedByMetadata,
  parseEnabledModulesHeader,
  gateModuleEmissions,
  ModuleGatingError,
  MODULE_GATING_ERROR,
} from './module-gating';
import type { ProjectModuleConfig } from './module-registry';

/**
 * Unit tests for module runtime/contribution gating (R4-E1-07, module-lifecycle
 * §6.1). Pure logic. Uses the dependency-free, non-locked `contacts` module for
 * enable/disable scenarios; locked always-on modules (`statistics`, `notifications`)
 * for forced-on projection checks. Invariant under test: a disabled module
 * contributes nothing and its runtime is frozen, but nothing here deletes data.
 */
const cfg = (moduleId: string, enabled: boolean, extra: Partial<ProjectModuleConfig> = {}):
  ProjectModuleConfig => ({
  moduleId,
  enabled,
  personalSettings: {},
  integrationSettings: {},
  integrationMethodsEnabled: [],
  ...extra,
});

describe('computeEffectiveModuleProjection', () => {
  it('marks an enabled module contributing + runtime-active', () => {
    const proj = computeEffectiveModuleProjection([cfg('contacts', true)]);
    const s = proj.find((p) => p.moduleId === 'contacts');
    expect(s).toEqual({
      moduleId: 'contacts',
      enabled: true,
      contributing: true,
      runtimeActive: true,
    });
  });

  it('marks a disabled module non-contributing + frozen', () => {
    const proj = computeEffectiveModuleProjection([cfg('contacts', false)]);
    const s = proj.find((p) => p.moduleId === 'contacts');
    expect(s).toMatchObject({ enabled: false, contributing: false, runtimeActive: false });
  });

  it('suspended runtimeStatus freezes runtime while still contributing', () => {
    const proj = computeEffectiveModuleProjection([
      cfg('contacts', true, { runtimeStatus: 'suspended' } as never),
    ]);
    const s = proj.find((p) => p.moduleId === 'contacts');
    expect(s).toMatchObject({ enabled: true, contributing: true, runtimeActive: false });
  });

  it('tolerates undefined/empty config (locked base modules are still forced-on)', () => {
    // An empty config still resolves locked/always-on modules (deals, statistics, notifications),
    // but an optional module we never enabled (contacts) must not appear.
    const fromUndef = computeEffectiveModuleProjection(undefined);
    const fromEmpty = computeEffectiveModuleProjection([]);
    expect(fromUndef).toEqual(fromEmpty);
    expect(fromEmpty.some((p) => p.moduleId === 'contacts')).toBe(false);
    expect(fromEmpty.some((p) => p.moduleId === 'statistics')).toBe(true);
    expect(fromEmpty.some((p) => p.moduleId === 'notifications')).toBe(true);
  });
});

describe('derived module sets', () => {
  const configs = [cfg('contacts', true)];
  it('computeEffectiveEnabledModules / RuntimeActiveModules include the enabled id', () => {
    expect(computeEffectiveEnabledModules(configs)).toContain('contacts');
    expect(computeRuntimeActiveModules(configs)).toContain('contacts');
    expect(computeEffectiveEnabledModules(configs)).toContain('statistics');
    expect(computeRuntimeActiveModules(configs)).toContain('statistics');
    expect(computeEffectiveEnabledModules(configs)).toContain('notifications');
    expect(computeRuntimeActiveModules([cfg('contacts', false)])).not.toContain('contacts');
  });

  it('isModuleContributing / isModuleRuntimeActive', () => {
    expect(isModuleContributing(configs, 'contacts')).toBe(true);
    expect(isModuleContributing([cfg('contacts', false)], 'contacts')).toBe(false);
    expect(isModuleRuntimeActive(configs, 'contacts')).toBe(true);
    expect(isModuleContributing(configs, 'statistics')).toBe(true);
    expect(isModuleRuntimeActive(configs, 'statistics')).toBe(true);
    expect(
      isModuleRuntimeActive([cfg('contacts', true, { runtimeStatus: 'suspended' } as never)], 'contacts'),
    ).toBe(false);
  });
});

describe('assertModuleContributing', () => {
  it('passes for an enabled module', () => {
    expect(() => assertModuleContributing([cfg('contacts', true)], 'contacts')).not.toThrow();
  });

  it('throws ModuleGatingError(CONTRIBUTION_DISABLED) for a disabled module', () => {
    try {
      assertModuleContributing([cfg('contacts', false)], 'contacts');
      throw new Error('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(ModuleGatingError);
      expect((e as ModuleGatingError).code).toBe(MODULE_GATING_ERROR.CONTRIBUTION_DISABLED);
      expect((e as ModuleGatingError).moduleId).toBe('contacts');
    }
  });
});

describe('metadata-based runtime gating (fail-open on absent)', () => {
  it('isModuleRuntimeAllowedByMetadata: absent metadata → allowed (s2s bypass)', () => {
    expect(isModuleRuntimeAllowedByMetadata(undefined, 'deals')).toBe(true);
  });
  it('isModuleRuntimeAllowedByMetadata: present list gates membership', () => {
    expect(isModuleRuntimeAllowedByMetadata(['deals'], 'deals')).toBe(true);
    expect(isModuleRuntimeAllowedByMetadata(['deals'], 'contacts')).toBe(false);
  });

  it('gateModuleEmissions: absent list passes through; present list filters', () => {
    const emissions = [{ moduleId: 'deals' }, { moduleId: 'contacts' }];
    expect(gateModuleEmissions(undefined, emissions)).toEqual(emissions);
    expect(gateModuleEmissions(['deals'], emissions)).toEqual([{ moduleId: 'deals' }]);
  });
});

describe('parseEnabledModulesHeader', () => {
  it('parses a JSON string array, filtering non-strings', () => {
    expect(parseEnabledModulesHeader('["deals","contacts"]')).toEqual(['deals', 'contacts']);
    expect(parseEnabledModulesHeader('["deals",1,null]')).toEqual(['deals']);
  });
  it('returns undefined for empty/non-string/malformed/non-array input', () => {
    expect(parseEnabledModulesHeader('')).toBeUndefined();
    expect(parseEnabledModulesHeader(undefined)).toBeUndefined();
    expect(parseEnabledModulesHeader(42)).toBeUndefined();
    expect(parseEnabledModulesHeader('{not json')).toBeUndefined();
    expect(parseEnabledModulesHeader('{"a":1}')).toBeUndefined();
  });
});
