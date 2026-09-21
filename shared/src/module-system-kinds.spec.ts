import { describe, it, expect } from '@jest/globals';
import { MODULE_REGISTRY } from './module-registry';
import { MODULE_MANIFESTS } from './module-manifests';

/** TODO-276 — shell modules statistics/notifications are system + locked in box. */
describe('system shell modules (TODO-276)', () => {
  it('marks statistics and notifications as locked registry entries', () => {
    expect(MODULE_REGISTRY.statistics.locked).toBe(true);
    expect(MODULE_REGISTRY.notifications.locked).toBe(true);
  });

  it('declares statistics and notifications manifests as kind system', () => {
    expect(MODULE_MANIFESTS.statistics.kind).toBe('system');
    expect(MODULE_MANIFESTS.notifications.kind).toBe('system');
  });
});
