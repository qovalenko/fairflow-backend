import { getModuleManifest, listModuleManifests } from './module-manifests';
import { getManifestMountPointIssues, manifestToNavCard } from './module-manifest';
import { getRoutingKeyEntry } from './routing-keys';
import { OPEN_SLOT_IDS } from './slot-catalog';

const OPEN_SLOTS = OPEN_SLOT_IDS;

/**
 * TODO-450: module slot contributions must actually reach the user.
 *
 * `manifestToNavCard` is what `GET /api/v1/platform/modules` returns; the host
 * scans `card.mountPoints` (`useSlotContributions`) and renders each entry via
 * `<Slot>`. Every real manifest declared navigation only, so the projection
 * always produced `mountPoints: []` — the activities contributions were written,
 * exposed by `modules/activities/vite.config.ts` and wired in the host's
 * `slotComponentMap`, yet nothing was ever mounted.
 *
 * These slot ids and component names are a CONTRACT with the host: the slot must
 * exist in the host SLOT_CATALOG (RFC-3 §1.2) and the component must be a key of
 * `loadRemoteComponent.slotComponentMap`, otherwise the contribution is silently
 * dropped at render time.
 */
describe('module manifest mountPoints (TODO-450)', () => {
  const activitiesCard = () => {
    const manifest = getModuleManifest('activities');
    expect(manifest).toBeDefined();
    return manifestToNavCard(manifest!, true);
  };

  it('activities contributes a non-empty mountPoints set to the nav card', () => {
    expect(activitiesCard().mountPoints.length).toBeGreaterThan(0);
  });

  it('contributes the activity timeline to all four entity-card tabs', () => {
    const tabs = activitiesCard().mountPoints.filter(
      (mp) => mp.component === 'ActivityCardTab',
    );
    expect(tabs.map((mp) => mp.slot).sort()).toEqual([
      'company.card.tab',
      'contact.card.tab',
      'deal.card.tab',
      'order.card.tab',
    ]);
    // The single implementation is parameterised by the slot's entity-ref
    // context prop (ActivityCardTab.resolveRef) — a mismatch here means the tab
    // mounts without an entity and renders empty.
    expect(
      Object.fromEntries(tabs.map((mp) => [mp.slot, mp.requiresContext])),
    ).toEqual({
      'contact.card.tab': ['contactId'],
      'company.card.tab': ['companyId'],
      'deal.card.tab': ['dealId'],
      'order.card.tab': ['orderId'],
    });
  });

  it('contributes the overdue widget to the dashboard slot the host renders', () => {
    const widget = activitiesCard().mountPoints.find(
      (mp) => mp.component === 'ActivityOverdueWidget',
    );
    expect(widget).toMatchObject({
      slot: 'dashboard.widget',
      requires: 'activities:read',
      requiresContext: ['projectId'],
    });
  });

  it('gates read contributions behind activities:read and write slots behind activities:write', () => {
    const card = activitiesCard();
    for (const mp of card.mountPoints) {
      if (mp.slot === 'list.action.menu' || mp.slot === 'list.bulk.action') {
        expect(mp.requires).toBe('activities:write');
      } else {
        expect(mp.requires).toBe('activities:read');
      }
    }
  });

  it('declares only slots a business-kind module may contribute to', () => {
    const card = activitiesCard();
    expect(card.kind).toBe('business');
    for (const mp of card.mountPoints) {
      // A host-only / system / reserved / unknown slot is rejected by both the
      // manifest validator and the host renderer — declaring one is dead weight.
      expect(OPEN_SLOTS.has(mp.slot as import('./slot-catalog').MountSlotId)).toBe(true);
    }
  });

  it('keeps navigation intact alongside the new mount-points', () => {
    expect(activitiesCard().navigation).toEqual([
      { path: '/activities', label: 'Активности', icon: 'PiCalendarCheck', requires: 'activities:read' },
    ]);
  });
});

/**
 * TODO-278 (ui-shell): host-only chrome slots must have manifest contributors so
 * `useSlotContributions` can mount host-local chrome wired in loadRemoteComponent.
 */
describe('ui-shell chrome slot contributions (TODO-278)', () => {
  const notificationsCard = () => {
    const manifest = getModuleManifest('notifications');
    expect(manifest).toBeDefined();
    return manifestToNavCard(manifest!, true);
  };

  const searchCard = () => {
    const manifest = getModuleManifest('search');
    expect(manifest).toBeDefined();
    return manifestToNavCard(manifest!, true);
  };

  it('notifications contributes header bell, nav badge and account menu item', () => {
    const card = notificationsCard();
    expect(card.mountPoints.map((mp) => mp.slot).sort()).toEqual([
      'account.menu.item',
      'nav.item.badge',
      'shell.header.action',
    ]);
    expect(
      Object.fromEntries(
        card.mountPoints.map((mp) => [mp.slot, mp.component]),
      ),
    ).toEqual({
      'shell.header.action': 'HeaderNotificationBell',
      'nav.item.badge': 'NavItemBadge',
      'account.menu.item': 'AccountMenuItem',
    });
  });

  it('search contributes GlobalSearchDialog to shell.header.action', () => {
    const mp = searchCard().mountPoints.find((e) => e.slot === 'shell.header.action');
    expect(mp).toEqual({
      slot: 'shell.header.action',
      component: 'GlobalSearchDialog',
      order: 10,
    });
  });

  it('nav.item.badge has automation and notifications contributors', () => {
    const badges = listModuleManifests()
      .map((m) => manifestToNavCard(m, true))
      .flatMap((card) =>
        card.mountPoints
          .filter((mp) => mp.slot === 'nav.item.badge')
          .map((mp) => ({ moduleId: card.id, mp })),
      );
    expect(badges.map((e) => e.moduleId)).toEqual(['automation', 'notifications']);
    expect(badges.find((e) => e.moduleId === 'automation')?.mp.component).toBe('NavDlqBadge');
    expect(badges.find((e) => e.moduleId === 'notifications')?.mp.component).toBe('NavItemBadge');
  });
});

/**
 * TODO-103: «модуль приносит свою вкладку настроек проекта».
 *
 * The host half was already there (host renders `project.settings.tab` in
 * `Settings.tsx`, `slotComponentMap` wires `search::SearchSettingsTab`, the
 * remote exposes it) — but no manifest declared a mount-point in that slot, so
 * `manifestToNavCard` shipped `mountPoints: []` and the tab was unreachable.
 * These assertions are the contract that keeps the chain whole end-to-end.
 */
describe('project.settings.tab contributions (TODO-103)', () => {
  /** `{ moduleId, mp }` for every mount-point aimed at the project-settings slot. */
  const settingsTabs = () =>
    listModuleManifests()
      .map((manifest) => manifestToNavCard(manifest, true))
      .flatMap((card) =>
        card.mountPoints
          .filter((mp) => mp.slot === 'project.settings.tab')
          .map((mp) => ({ moduleId: card.id, mp })),
      );

  const tabsOf = (moduleId: string) =>
    settingsTabs()
      .filter((e) => e.moduleId === moduleId)
      .map((e) => e.mp);

  it('search declares SearchSettingsTab in the project-settings slot', () => {
    expect(tabsOf('search')).toEqual([
      {
        slot: 'project.settings.tab',
        component: 'SearchSettingsTab',
        requires: 'project:manage',
        requiresContext: ['projectId'],
        order: 100,
      },
    ]);
  });

  it('the slot has at least one contributor (an empty slot is a dead mechanism)', () => {
    expect(settingsTabs().map((e) => e.moduleId)).toContain('search');
  });

  it('every contribution mirrors the server gate of the settings endpoints', () => {
    // Gateway `common-bff.controller.ts` guards GET *and* PUT
    // `projects/:projectId/modules/:moduleId/settings` with
    // @RequirePermission('project','manage'). A tab declaring anything else
    // would be shown to users whose API calls answer 403 — and, since
    // `project.settings.tab` is `accessKind:'open'` (OQ-MODULE-130), the module
    // kind no longer gates it: `requires` is the only gate left.
    for (const { moduleId, mp } of settingsTabs()) {
      expect(`${moduleId}:${mp.requires ?? '<none>'}`).toBe(`${moduleId}:project:manage`);
    }
  });

  it('every contribution asks for the projectId the host slot passes', () => {
    // `<Slot id="project.settings.tab" context={{ projectId }} />` — a
    // contribution requiring a context prop the host does not pass never renders.
    for (const { mp } of settingsTabs()) {
      expect(mp.requiresContext ?? []).toEqual(['projectId']);
    }
  });
});

/**
 * FR-AUTOM-430: automation contributes DLQ nav badge via `nav.item.badge`.
 */
describe('automation nav.item.badge (FR-AUTOM-430)', () => {
  const automationCard = () => {
    const manifest = getModuleManifest('automation');
    expect(manifest).toBeDefined();
    return manifestToNavCard(manifest!, true);
  };

  it('declares NavDlqBadge for nav.item.badge with manage gate', () => {
    const badge = automationCard().mountPoints.find((mp) => mp.slot === 'nav.item.badge');
    expect(badge).toMatchObject({
      component: 'NavDlqBadge',
      requires: 'automation:manage',
      requiresContext: ['moduleId'],
    });
  });

  it('uses an open catalog slot allowed for business modules', () => {
    const mp = automationCard().mountPoints.find((mp) => mp.slot === 'nav.item.badge');
    expect(mp).toBeDefined();
    expect(OPEN_SLOTS.has(mp!.slot as import('./slot-catalog').MountSlotId)).toBe(true);
  });
});

/**
 * FR-DEALS-460: deals contributes cross-module card tabs via mountPoints.
 */
describe('deals entity-card mountPoints (FR-DEALS-460)', () => {
  const dealsCard = () => {
    const manifest = getModuleManifest('deals');
    expect(manifest).toBeDefined();
    return manifestToNavCard(manifest!, true);
  };

  it('contributes DealsCardTab to contact and company card tabs', () => {
    const tabs = dealsCard().mountPoints.filter((mp) => mp.component === 'DealsCardTab');
    expect(tabs.map((mp) => mp.slot).sort()).toEqual(['company.card.tab', 'contact.card.tab']);
    expect(
      Object.fromEntries(tabs.map((mp) => [mp.slot, mp.requiresContext])),
    ).toEqual({
      'contact.card.tab': ['contactId'],
      'company.card.tab': ['companyId'],
    });
  });

  it('gates tabs behind deals:read', () => {
    for (const mp of dealsCard().mountPoints) {
      expect(mp.requires).toBe('deals:read');
    }
  });

  it('declares drawerEntities deal for global quick-create (FR-DEALS-460)', () => {
    const manifest = getModuleManifest('deals');
    expect(manifest?.frontend?.drawerEntities).toEqual(['deal']);
  });
});

/**
 * TODO-239: the `control.module.*` keys had no emitter and were parked as
 * `planned`. `ProjectsService.update` now emits all five, so the contract must
 * say so — a `planned` key is not bound on the broker.
 */
describe('control.module.* routing keys (TODO-239)', () => {
  const statusOf = (key: string) => getRoutingKeyEntry(key)?.status;

  it.each([
    'control.module.enabled',
    'control.module.disabled',
    'control.module.installed',
    'control.module.upgraded',
    'control.module.uninstalled',
  ])('%s is active', (key) => {
    expect(statusOf(key)).toBe('active');
  });
});

/**
 * FR-SHELL-210 / TODO-517: BE validator lifecycle — every shipped manifest must
 * declare mount-points that pass the canonical SLOT_CATALOG rules (same as host
 * `rejectSlotContribution`). Singleton federation versions / partner namespace /
 * trust-class are out of scope for BOX v1 (partner → validatePartnerManifest).
 */
describe('all module manifests — mount-point catalog validation (FR-SHELL-210)', () => {
  it('every real manifest has no slot-catalog violations', () => {
    const violations: Array<{ moduleId: string; issues: ReturnType<typeof getManifestMountPointIssues> }> =
      [];
    for (const manifest of listModuleManifests()) {
      const issues = getManifestMountPointIssues(manifest);
      if (issues.length > 0) violations.push({ moduleId: manifest.id, issues });
    }
    expect(violations).toEqual([]);
  });
});
