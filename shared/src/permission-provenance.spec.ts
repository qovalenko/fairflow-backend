import { compileEffectivePermissionsWithSources } from './permission-rbac';

describe('FR-ACCESS-550 permission provenance', () => {
  const catalogKeys = new Set(['deals:read', 'deals:write', 'contacts:read']);

  it('tags allow keys with role and grant sources', () => {
    const compiled = compileEffectivePermissionsWithSources(
      [
        {
          permissionKeys: ['deals:read', 'deals:write'],
          source: 'baseline:member',
        },
      ],
      [{ effect: 'allow', key: 'contacts:read', source: 'grant:allow' }],
      catalogKeys,
    );
    expect(compiled.allow).toEqual(['contacts:read', 'deals:read', 'deals:write']);
    expect(compiled.sources['deals:read']).toBe('baseline:member');
    expect(compiled.sources['contacts:read']).toBe('grant:allow');
  });

  it('deny source wins over allow for the same key', () => {
    const compiled = compileEffectivePermissionsWithSources(
      [{ permissionKeys: ['deals:write'], source: 'baseline:manager' }],
      [{ effect: 'deny', key: 'deals:write', source: 'grant:deny' }],
      catalogKeys,
    );
    expect(compiled.allow).not.toContain('deals:write');
    expect(compiled.sources['deals:write']).toBe('grant:deny');
  });
});
