import {
  OPEN_SLOT_IDS,
  SLOT_CATALOG,
  rejectSlotContribution,
  validateManifestMountPoints,
} from './slot-catalog';

describe('slot-catalog (FR-SHELL-080)', () => {
  it('exports every catalog slot id', () => {
    expect(SLOT_CATALOG.length).toBeGreaterThan(10);
    expect(OPEN_SLOT_IDS.has('project.settings.tab')).toBe(true);
  });

  it('rejects unknown and reserved slots', () => {
    expect(rejectSlotContribution('project.settings.tabs', 'business')).toBe('UNKNOWN_SLOT');
    expect(rejectSlotContribution('org.dashboard.widget', 'system')).toBe('SLOT_RESERVED');
  });

  it('validates manifest mount-points (FR-SHELL-210)', () => {
    const issues = validateManifestMountPoints(
      [{ slot: 'shell.header.action' }, { slot: 'deal.card.tab' }],
      'business',
    );
    expect(issues).toEqual([{ slot: 'shell.header.action', reason: 'HOST_ONLY_SLOT_FORBIDDEN' }]);
  });
});
