/**
 * Regression suite for T-006: system subjects (`roles`, `project`, `members`)
 * must reach the project catalog and thus the owner's compiled permission-set,
 * while the module namespace filter must STILL drop out-of-namespace subjects of
 * ordinary business modules (safety not weakened).
 */
import {
  buildPermissionCatalog,
  SYSTEM_PERMISSION_MODULE_ID,
} from './permission-catalog';
import { moduleDefinitionToManifest } from './module-manifest';
import type { ModuleDefinition } from './module-registry';
import {
  buildProjectCatalogWithSystem,
  expandAllSystemRoles,
  expandSystemRolePermissions,
} from './permission-rbac';
import { projectRoleCanKey } from './rbac';

describe('system permission projection (T-006)', () => {
  const catalog = buildProjectCatalogWithSystem(['deals']);

  it('exposes system subjects in the project catalog', () => {
    expect(catalog.hasKey('roles:read')).toBe(true);
    expect(catalog.hasKey('roles:manage')).toBe(true);
    expect(catalog.hasKey('project:read')).toBe(true);
    expect(catalog.hasKey('project:manage')).toBe(true);
    expect(catalog.hasKey('project:delete')).toBe(true);
    expect(catalog.hasKey('members:manage')).toBe(true);
  });

  it('grants the owner role project:manage / roles:* / members:manage', () => {
    const owner = expandSystemRolePermissions('owner', catalog);
    expect(owner).toEqual(expect.arrayContaining([
      'project:manage',
      'project:delete',
      'roles:read',
      'roles:manage',
      'members:manage',
    ]));
  });

  it('grants the owner role deals:export (working-data export)', () => {
    expect(catalog.hasKey('deals:export')).toBe(true);
    const owner = expandSystemRolePermissions('owner', catalog);
    expect(owner).toContain('deals:export');
  });

  it('member gets working-data deals:export but not roles:manage/members:manage', () => {
    const roles = expandAllSystemRoles(catalog);
    expect(roles.member).toContain('deals:export');
    expect(roles.member).not.toContain('roles:manage');
    expect(roles.member).not.toContain('members:manage');
    expect(roles.member).not.toContain('project:manage');
  });
});

describe('granular member grant: documents.generate:execute (owner decision 2026-08-16)', () => {
  // Full CRM catalog with both execute-bearing subjects present
  // (`documents.generate` and `automation`) — the trap this guards against is
  // the grant silently widening to EVERY `*:execute` key.
  const catalog = buildProjectCatalogWithSystem([
    'deals',
    'orders',
    'activities',
    'documents',
    'automation',
  ]);

  it('member expansion contains documents.generate:execute', () => {
    const member = expandSystemRolePermissions('member', catalog);
    expect(member).toContain('documents.generate:execute');
  });

  it('member expansion contains NO other :execute key (granularity proof)', () => {
    const member = expandSystemRolePermissions('member', catalog);
    const executeKeys = member.filter((k) => k.endsWith(':execute'));
    expect(executeKeys).toEqual(['documents.generate:execute']);
    // The catalog itself DOES carry another execute key — so the assertion
    // above is meaningful, not vacuous.
    expect(catalog.hasKey('automation:execute')).toBe(true);
    expect(member).not.toContain('automation:execute');
  });

  it('viewer does NOT inherit the member grant', () => {
    const viewer = expandSystemRolePermissions('viewer', catalog);
    expect(viewer.filter((k) => k.endsWith(':execute'))).toEqual([]);
  });

  it('manager/owner keep their full execute set (unchanged)', () => {
    const roles = expandAllSystemRoles(catalog);
    for (const r of ['owner', 'admin', 'manager'] as const) {
      expect(roles[r]).toContain('documents.generate:execute');
      expect(roles[r]).toContain('automation:execute');
    }
  });

  it('the grant is dropped when the documents module is disabled (off-catalog)', () => {
    const noDocs = buildProjectCatalogWithSystem(['deals', 'automation', 'activities']);
    const member = expandSystemRolePermissions('member', noDocs);
    expect(member).not.toContain('documents.generate:execute');
  });

  it('projectRoleCanKey: member may execute documents.generate and nothing else', () => {
    expect(projectRoleCanKey('member', 'documents.generate', 'execute')).toBe(true);
    // Not a blanket `execute`:
    expect(projectRoleCanKey('member', 'automation', 'execute')).toBe(false);
    expect(projectRoleCanKey('member', 'companies', 'execute')).toBe(false);
    // Other elevated actions stay denied:
    expect(projectRoleCanKey('member', 'deals', 'delete')).toBe(false);
    expect(projectRoleCanKey('member', 'deals', 'manage')).toBe(false);
    // Matrix behaviour is untouched for actions the role already holds:
    expect(projectRoleCanKey('member', 'deals', 'move')).toBe(true);
    // viewer gains nothing:
    expect(projectRoleCanKey('viewer', 'documents.generate', 'execute')).toBe(false);
  });
});

describe('namespace filter still cuts foreign subjects of business modules (security regression)', () => {
  it('drops a business module subject declared outside its namespace', () => {
    const rogue: ModuleDefinition = {
      id: 'widgets',
      name: 'Widgets',
      description: 'test module with an out-of-namespace subject',
      locked: false,
      dependencies: [],
      integrationMethods: [],
      personalSettingsSchema: {},
      integrationSettingsSchema: {},
      policyCapabilities: [
        // in-namespace: kept
        { subject: 'widgets', actions: ['read', 'manage'] },
        // out-of-namespace: MUST be dropped (cannot widen the catalog)
        { subject: 'roles', actions: ['manage'] },
        { subject: 'deals', actions: ['delete'] },
      ],
    };
    const catalog = buildPermissionCatalog([moduleDefinitionToManifest(rogue)]);
    expect(catalog.hasKey('widgets:read')).toBe(true);
    expect(catalog.hasKey('widgets:manage')).toBe(true);
    // A non-system module can NOT inject system/foreign subjects.
    expect(catalog.hasKey('roles:manage')).toBe(false);
    expect(catalog.hasKey('deals:delete')).toBe(false);
  });

  it('only the system module id is exempt from the namespace filter', () => {
    expect(SYSTEM_PERMISSION_MODULE_ID).toBe('core');
    const sys: ModuleDefinition = {
      id: SYSTEM_PERMISSION_MODULE_ID,
      name: 'System',
      description: 'system subjects',
      locked: true,
      dependencies: [],
      integrationMethods: [],
      personalSettingsSchema: {},
      integrationSettingsSchema: {},
      policyCapabilities: [
        { subject: 'roles', actions: ['read', 'manage'] },
        { subject: 'project', actions: ['read', 'manage', 'delete'] },
        { subject: 'members', actions: ['manage'] },
      ],
    };
    const catalog = buildPermissionCatalog([moduleDefinitionToManifest(sys)]);
    expect(catalog.hasKey('roles:manage')).toBe(true);
    expect(catalog.hasKey('project:delete')).toBe(true);
    expect(catalog.hasKey('members:manage')).toBe(true);
  });
});
