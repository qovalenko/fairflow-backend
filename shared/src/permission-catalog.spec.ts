import {
  permissionKey,
  parsePermissionKey,
  buildPermissionCatalog,
  SYSTEM_PERMISSION_MODULE_ID,
} from './permission-catalog';
import type { ModuleManifestV1 } from './module-manifest';
import { listModuleManifests } from './module-manifests';

/**
 * Unit tests for the permission-catalog builder (FR-MOD-17). Pure logic; the
 * catalog is the union of module manifests' `permissions[]` and the atomic unit
 * roles/policy reference. Namespace enforcement (FR-MOD-26a) and the `core` system
 * exemption (FR-PERM-24) are the security-relevant branches.
 */
describe('permissionKey / parsePermissionKey', () => {
  it('encodes and decodes a subject:action key', () => {
    expect(permissionKey('deals', 'read')).toBe('deals:read');
    expect(parsePermissionKey('deals:read')).toEqual({ subject: 'deals', action: 'read' });
  });

  it('splits on the LAST colon (namespaced subjects)', () => {
    expect(parsePermissionKey('documents.generate:execute')).toEqual({
      subject: 'documents.generate',
      action: 'execute',
    });
  });

  it('rejects malformed keys', () => {
    expect(parsePermissionKey('noколон')).toBeNull();
    expect(parsePermissionKey(':read')).toBeNull();
    expect(parsePermissionKey('deals:')).toBeNull();
  });
});

describe('buildPermissionCatalog', () => {
  const manifest = (id: string, perms: { subject: string; actions: string[] }[]): ModuleManifestV1 =>
    ({
      id,
      permissions: perms,
    }) as unknown as ModuleManifestV1;

  it('unions permissions across manifests, dedups + sorts deterministically', () => {
    const cat = buildPermissionCatalog([
      manifest('deals', [{ subject: 'deals', actions: ['read', 'write'] }]),
      manifest('contacts', [{ subject: 'contacts', actions: ['read'] }]),
      // same subject contributed again (in-namespace) → actions merged + deduped
      manifest('deals', [{ subject: 'deals', actions: ['read', 'delete'] }]),
    ]);
    expect(cat.keys).toEqual([
      'contacts:read',
      'deals:delete',
      'deals:read',
      'deals:write',
    ]);
    const deals = cat.entries.find((e) => e.subject === 'deals');
    expect(deals?.actions).toEqual(['delete', 'read', 'write']);
    expect(deals?.moduleIds).toEqual(['deals']);
  });

  it('has()/hasKey() answer membership', () => {
    const cat = buildPermissionCatalog([
      manifest('deals', [{ subject: 'deals', actions: ['read'] }]),
    ]);
    expect(cat.has('deals', 'read')).toBe(true);
    expect(cat.has('deals', 'delete')).toBe(false);
    expect(cat.hasKey('deals:read')).toBe(true);
    expect(cat.hasKey('deals:delete')).toBe(false);
  });

  it('drops out-of-namespace subjects for business modules (FR-MOD-26a)', () => {
    // subject "other" is not within the "deals" namespace → dropped.
    const cat = buildPermissionCatalog([
      manifest('deals', [
        { subject: 'deals', actions: ['read'] },
        { subject: 'other', actions: ['write'] },
      ]),
    ]);
    expect(cat.has('deals', 'read')).toBe(true);
    expect(cat.has('other', 'write')).toBe(false);
  });

  it('TODO-045: the real documents module contributes documents.generate:execute', () => {
    // The FE gates the generate/upload buttons on this exact key and the
    // decorator map resolves `documents:generate` to it — it MUST be in the
    // catalog built from the registry manifests, else nobody (incl. the project
    // owner) ever holds it.
    const cat = buildPermissionCatalog(listModuleManifests());
    expect(cat.hasKey('documents.generate:execute')).toBe(true);
    expect(cat.has('documents', 'write')).toBe(true);
  });

  it('exempts the core system module from the namespace filter (FR-PERM-24)', () => {
    const cat = buildPermissionCatalog([
      manifest(SYSTEM_PERMISSION_MODULE_ID, [
        { subject: 'roles', actions: ['manage'] },
        { subject: 'project', actions: ['manage'] },
      ]),
    ]);
    // bare system subjects survive even though they are outside any module namespace
    expect(cat.has('roles', 'manage')).toBe(true);
    expect(cat.has('project', 'manage')).toBe(true);
  });
});
