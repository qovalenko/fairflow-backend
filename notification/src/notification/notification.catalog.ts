// Curated notification category catalog (contract §3.8 / §5.1).
//
// Category defaults (`default_channels`) are sourced from notification-defaults.ts
// (profile-module TZ §7.4, FR-PROFILE-270). Project-scoped filtering by enabled
// modules is applied in GetCatalog via filterCatalogByModules (FR-PROFILE-240).
import { ensureLockedModules, MODULE_REGISTRY } from '@fairflow/shared';
import { defaultChannelsForCategory } from './notification-defaults';

export type CategorySpec = {
  category: string;
  module: string;
  title: string;
  severity: 'info' | 'important' | 'critical';
  default_channels: string[];
  mandatory: boolean;
  /** NFR-100: categories whose email leg may carry PII outside the contour. */
  email_contains_pii?: boolean;
};

function cat(
  category: string,
  module: string,
  title: string,
  severity: CategorySpec['severity'],
  mandatory: boolean,
  extra?: Pick<CategorySpec, 'email_contains_pii'>,
): CategorySpec {
  return {
    category,
    module,
    title,
    severity,
    default_channels: defaultChannelsForCategory(category),
    mandatory,
    ...extra,
  };
}

export const NOTIFICATION_CATALOG: CategorySpec[] = [
  cat('deals', 'deals', 'Сделки', 'info', false),
  cat('sales', 'orders', 'Продажи', 'critical', true, { email_contains_pii: true }),
  cat('data', 'control', 'Данные', 'info', false),
  cat('activities', 'activities', 'Активности', 'important', false),
  cat('org', 'control', 'Организация', 'critical', true),
  cat('billing', 'billing', 'Биллинг', 'critical', true),
  cat('import', 'control', 'Импорт', 'info', false),
  // chat (M-CHAT-7): a new message in a conversation vs being @mentioned. Both
  // come from the single chat.message.created fact (B-2 — no separate mention key).
  cat('new_message', 'chat', 'Новые сообщения', 'info', false),
  cat('mention', 'chat', 'Упоминания', 'important', false, { email_contains_pii: true }),
];

/** BOX edition omits cloud billing; default edition is box on integration/box-gap. */
export function isBoxEdition(): boolean {
  const edition = (process.env.FAIRFLOW_EDITION ?? 'box').trim().toLowerCase();
  return edition !== 'cloud';
}

/** Catalog filtered for the running edition (billing omitted in BOX). */
export function catalogForEdition(): CategorySpec[] {
  if (!isBoxEdition()) return NOTIFICATION_CATALOG;
  return NOTIFICATION_CATALOG.filter((c) => c.category !== 'billing' && c.module !== 'billing');
}

/** Hide categories whose source module is disabled in the project (FR-PROFILE-240). */
export function filterCatalogByModules(
  categories: CategorySpec[],
  effectiveModules: string[],
): CategorySpec[] {
  const enabled = new Set(ensureLockedModules(effectiveModules));
  enabled.add('notifications');
  enabled.add('statistics');
  return categories.filter((c) => {
    // `control` (and any other platform domain) is not a toggleable CRM module —
    // it never appears in effectiveModules. Dropping those rows hid org/data/import
    // from GET /catalog (settings matrix) on every project.
    if (!(c.module in MODULE_REGISTRY)) return true;
    return enabled.has(c.module);
  });
}

const MANDATORY = new Set(NOTIFICATION_CATALOG.filter((c) => c.mandatory).map((c) => c.category));

// FR-MNOT-17: mandatory ⇔ critical, cannot be disabled in preferences.
export function isMandatory(category: string): boolean {
  if (isBoxEdition() && category === 'billing') return false;
  return MANDATORY.has(category);
}
