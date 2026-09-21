import { describe, it, expect } from '@jest/globals';
import { MODULE_MANIFESTS } from './module-manifests';
import { MODULE_REGISTRY } from './module-registry';
import {
  assertReadOnlyModules,
  validateReadOnlyModule,
  READ_ONLY_MODULE_IDS,
} from './module-readonly';
import type { ModuleManifestV1 } from './module-manifest';

describe('read-only module contract (FR-STAT-030)', () => {
  it('statistics manifest passes the read-only validator', () => {
    const result = validateReadOnlyModule(MODULE_MANIFESTS.statistics);
    expect(result.ok).toBe(true);
    expect(result.violations).toEqual([]);
  });

  it('registry build asserts all read-only modules at startup', () => {
    expect(() => assertReadOnlyModules(MODULE_MANIFESTS)).not.toThrow();
  });

  it('rejects write/delete/manage on a read-only module', () => {
    const bad: ModuleManifestV1 = {
      ...MODULE_MANIFESTS.statistics,
      permissions: [{ subject: 'statistics', actions: ['read', 'write'] }],
    };
    const result = validateReadOnlyModule(bad);
    expect(result.ok).toBe(false);
    expect(result.violations.some((v) => v.code === 'FORBIDDEN_MUTATING_ACTION')).toBe(true);
  });

  it('rejects non-empty dataSubjects on a read-only module', () => {
    const bad: ModuleManifestV1 = {
      ...MODULE_MANIFESTS.statistics,
      dataSubjects: [{ resource: 'statistics', ownable: false, shareable: false, abacBackend: 'mongo' }],
    };
    const result = validateReadOnlyModule(bad);
    expect(result.ok).toBe(false);
    expect(result.violations.some((v) => v.code === 'DATASUBJECTS_NON_EMPTY')).toBe(true);
  });

  it('ignores non read-only modules', () => {
    expect(validateReadOnlyModule(MODULE_MANIFESTS.deals).ok).toBe(true);
  });
});

describe('legacy integrationMethods cleanup (FR-STAT-040)', () => {
  it('statistics registry entry has no dotted legacy integration method ids', () => {
    const def = MODULE_REGISTRY.statistics;
    expect(def.integrationMethods).toEqual([]);
    for (const method of def.integrationMethods) {
      expect(method.id).not.toMatch(/^statistics\.read\./);
    }
  });

  it('only statistics is in the read-only module id list (explicit contract)', () => {
    expect(READ_ONLY_MODULE_IDS).toContain('statistics');
  });
});
