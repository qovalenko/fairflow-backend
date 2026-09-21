import {
  NOTIFICATION_CATEGORY_DEFAULTS,
  defaultCategoryPref,
  defaultChannelsForCategory,
} from './notification-defaults';
import { NOTIFICATION_CATALOG } from './notification.catalog';

describe('notification-defaults (FR-PROFILE-270 / TZ §7.4)', () => {
  it('defines explicit defaults for every catalog category', () => {
    for (const spec of NOTIFICATION_CATALOG) {
      expect(NOTIFICATION_CATEGORY_DEFAULTS[spec.category]).toBeDefined();
    }
  });

  it('maps defaults to default_channels shape used by the catalog', () => {
    for (const spec of NOTIFICATION_CATALOG) {
      expect(defaultChannelsForCategory(spec.category).sort()).toEqual(
        [...spec.default_channels].sort(),
      );
    }
  });

  it('keeps critical categories fully on by default', () => {
    expect(defaultCategoryPref('sales')).toEqual({ in_app: true, email: true });
    expect(defaultCategoryPref('org')).toEqual({ in_app: true, email: true });
  });

  it('defaults deals to in-app only', () => {
    expect(defaultCategoryPref('deals')).toEqual({ in_app: true, email: false });
  });
});
