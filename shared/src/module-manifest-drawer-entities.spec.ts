import { getModuleManifest } from './module-manifests';
import { manifestToNavCard } from './module-manifest';

/**
 * FR-SHELL-270 / FR-MOD-28: quick-create types must come from manifest
 * `drawerEntities[]`, not a hardcoded host list.
 */
describe('module manifest drawerEntities (FR-SHELL-270)', () => {
  const drawerOf = (moduleId: string) => {
    const manifest = getModuleManifest(moduleId);
    expect(manifest).toBeDefined();
    return manifestToNavCard(manifest!, true).drawerEntities;
  };

  it('contacts declares contact', () => {
    expect(drawerOf('contacts')).toEqual(['contact']);
  });

  it('companies declares company', () => {
    expect(drawerOf('companies')).toEqual(['company']);
  });

  it('deals declares deal', () => {
    expect(drawerOf('deals')).toEqual(['deal']);
  });

  it('orders declares order', () => {
    expect(drawerOf('orders')).toEqual(['order']);
  });

  it('activities declares task/call/meeting/note', () => {
    expect(drawerOf('activities')).toEqual(['task', 'call', 'meeting', 'note']);
  });

  it('profile declares user for global drawer', () => {
    expect(drawerOf('profile')).toEqual(['user']);
  });
});
