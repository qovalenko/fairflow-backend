/**
 * Explicit per-category notification defaults for new users (profile-module TZ §7.4,
 * FR-PROFILE-270). Source of truth for default on/off — not derived ad hoc from
 * delivery matrix or catalog metadata at read time.
 */
export type CategoryDefault = {
  in_app: boolean;
  email: boolean;
};

/** §7.4 v1 — aligned with NOTIFICATION_CATALOG categories in notification.catalog.ts */
export const NOTIFICATION_CATEGORY_DEFAULTS: Record<string, CategoryDefault> = {
  deals: { in_app: true, email: false },
  sales: { in_app: true, email: true },
  data: { in_app: true, email: false },
  activities: { in_app: true, email: true },
  org: { in_app: true, email: true },
  billing: { in_app: true, email: true },
  import: { in_app: true, email: false },
  new_message: { in_app: true, email: false },
  mention: { in_app: true, email: true },
};

export function defaultChannelsForCategory(category: string): ('in_app' | 'email')[] {
  const d = NOTIFICATION_CATEGORY_DEFAULTS[category];
  if (!d) return ['in_app'];
  const channels: ('in_app' | 'email')[] = [];
  if (d.in_app) channels.push('in_app');
  if (d.email) channels.push('email');
  return channels.length ? channels : ['in_app'];
}

export function defaultCategoryPref(category: string): CategoryDefault {
  return NOTIFICATION_CATEGORY_DEFAULTS[category] ?? { in_app: true, email: false };
}
