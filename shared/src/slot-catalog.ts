/**
 * Canonical SLOT_CATALOG (RFC-3, FR-SHELL-080).
 *
 * Single source of truth for host shell and backend manifest validation.
 * Host re-exports this artifact via `@fairflow/slot-catalog` alias.
 */

export type MountSlotId =
  | 'contact.card.tab'
  | 'contact.card.sidebar'
  | 'company.card.tab'
  | 'company.card.sidebar'
  | 'deal.card.tab'
  | 'deal.card.sidebar'
  | 'deal.card.action'
  | 'order.card.tab'
  | 'global.drawer.entity'
  | 'list.action.menu'
  | 'list.bulk.action'
  | 'nav.item.badge'
  | 'dashboard.kpi.cell'
  | 'dashboard.widget'
  | 'dashboard.list'
  | 'shell.header.action'
  | 'account.menu.item'
  | 'project.settings.tab'
  | 'org.dashboard.widget'
  | 'project.summary.card';

export type SlotAccessKind = 'open' | 'system' | 'host-only';

export interface SlotDescriptor {
  slot: MountSlotId;
  contextProps: string[];
  accessKind: SlotAccessKind;
  requires?: string;
  reserved?: boolean;
}

/** OQ-SHELL-040 default: visible contributors before «ещё N» collapse. */
export const SLOT_CONTRIBUTOR_VISIBLE_LIMIT = 5;

export const SLOT_CATALOG: readonly SlotDescriptor[] = [
  { slot: 'contact.card.tab', contextProps: ['contactId'], accessKind: 'open' },
  { slot: 'contact.card.sidebar', contextProps: ['contactId'], accessKind: 'open' },
  { slot: 'company.card.tab', contextProps: ['companyId'], accessKind: 'open' },
  { slot: 'company.card.sidebar', contextProps: ['companyId'], accessKind: 'open' },
  { slot: 'deal.card.tab', contextProps: ['dealId'], accessKind: 'open' },
  { slot: 'deal.card.sidebar', contextProps: ['dealId'], accessKind: 'open' },
  { slot: 'deal.card.action', contextProps: ['dealId'], accessKind: 'open' },
  { slot: 'order.card.tab', contextProps: ['orderId'], accessKind: 'open' },
  { slot: 'global.drawer.entity', contextProps: ['entityType', 'entityId'], accessKind: 'open' },
  { slot: 'list.action.menu', contextProps: ['entityType', 'recordId'], accessKind: 'open' },
  { slot: 'list.bulk.action', contextProps: ['entityType', 'selectedIds'], accessKind: 'open' },
  { slot: 'nav.item.badge', contextProps: ['moduleId'], accessKind: 'open' },
  { slot: 'dashboard.kpi.cell', contextProps: ['projectId', 'period'], accessKind: 'open' },
  { slot: 'dashboard.widget', contextProps: ['projectId', 'period'], accessKind: 'open' },
  { slot: 'dashboard.list', contextProps: ['projectId', 'period'], accessKind: 'open' },
  { slot: 'shell.header.action', contextProps: [], accessKind: 'host-only' },
  { slot: 'account.menu.item', contextProps: [], accessKind: 'host-only' },
  {
    slot: 'project.settings.tab',
    contextProps: ['projectId'],
    accessKind: 'open',
    requires: 'project:manage',
  },
  { slot: 'org.dashboard.widget', contextProps: [], accessKind: 'open', reserved: true },
  { slot: 'project.summary.card', contextProps: [], accessKind: 'open', reserved: true },
];

const SLOT_BY_ID: Record<string, SlotDescriptor> = Object.fromEntries(
  SLOT_CATALOG.map((d) => [d.slot, d]),
);

/** Open slots a business-kind module may contribute to (validator mirror). */
export const OPEN_SLOT_IDS = new Set(
  SLOT_CATALOG.filter((d) => d.accessKind === 'open' && !d.reserved).map((d) => d.slot),
);

export type SlotRejectReason =
  | 'UNKNOWN_SLOT'
  | 'SLOT_RESERVED'
  | 'HOST_ONLY_SLOT_FORBIDDEN'
  | 'SYSTEM_SLOT_FORBIDDEN';

export function getSlotDescriptor(slot: string): SlotDescriptor | undefined {
  return SLOT_BY_ID[slot];
}

export function isKnownSlot(slot: string): slot is MountSlotId {
  return slot in SLOT_BY_ID;
}

export function rejectSlotContribution(
  slot: string,
  moduleKind: 'system' | 'business' | 'partner' | undefined,
): SlotRejectReason | null {
  const desc = SLOT_BY_ID[slot];
  if (!desc) return 'UNKNOWN_SLOT';
  if (desc.reserved) return 'SLOT_RESERVED';
  const kind = moduleKind ?? 'business';
  if (desc.accessKind === 'host-only' && kind !== 'system') {
    return 'HOST_ONLY_SLOT_FORBIDDEN';
  }
  if (desc.accessKind === 'system' && kind !== 'system') {
    return 'SYSTEM_SLOT_FORBIDDEN';
  }
  return null;
}

export type MountPointValidationIssue = {
  slot: string;
  reason: SlotRejectReason;
};

/** FR-SHELL-210 (in-scope): validate manifest mount-points against the catalog. */
export function validateManifestMountPoints(
  mountPoints: Array<{ slot: string }> | undefined,
  moduleKind: 'system' | 'business' | 'partner',
): MountPointValidationIssue[] {
  if (!mountPoints?.length) return [];
  const issues: MountPointValidationIssue[] = [];
  for (const mp of mountPoints) {
    const reason = rejectSlotContribution(mp.slot, moduleKind);
    if (reason) issues.push({ slot: mp.slot, reason });
  }
  return issues;
}
