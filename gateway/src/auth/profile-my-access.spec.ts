import { formatVisibilityLevelLabel } from './profile-visibility';

describe('formatVisibilityLevelLabel (FR-PROFILE-280)', () => {
  it('maps visibility levels to human-readable deal scope', () => {
    expect(formatVisibilityLevelLabel('only_own')).toBe('Видишь сделки: только свои');
    expect(formatVisibilityLevelLabel('all')).toBe('Видишь сделки: все записи проекта');
  });

  it('falls back to the raw level for unknown values', () => {
    expect(formatVisibilityLevelLabel('custom_policy')).toBe('custom_policy');
  });
});
