/**
 * Real per-module `ModuleManifestV1` set (E1-12 / I2a, DoD Stage 1).
 *
 * Source of truth: docs/tz/areas/module-contract/TZ.md §5.1, module-lifecycle/TZ.md,
 * RFC-2-manifest.md, RFC-4 (events / routing-keys).
 *
 * This replaces the legacy-bridge synthesis (`moduleDefinitionToManifest`) as the
 * authoritative description of what each 1st-party/system module contributes:
 * real `version`, `kind`, `vendor`, `platformApi`, host `navigation`, `dataSubjects`
 * (ownership/visibility inheritance, FR-MOD-21) and `backend.events.emits/listens`
 * (FR-MOD-24). The platform derives navigation, the permission catalog, the
 * event contract and ownership inheritance from THESE manifests; lifecycle
 * enable/disable then makes the whole contribution (nav + fields/events + slots)
 * appear/disappear per-project (FR-MOD-27 / module-gating.ts) without core edits.
 *
 * ADDITIVE & non-breaking: `permissions` and `settingsSchema` continue to flow
 * from `MODULE_REGISTRY` (`policyCapabilities` / settings schemas) so the existing
 * permission catalog and auto-form keep working verbatim. `getModuleManifest`
 * merges the real declarative manifest below with the registry-derived
 * permissions/settings; any module without a real entry here transparently falls
 * back to the full legacy bridge (`moduleDefinitionToManifest`).
 */

import {
  MANIFEST_CONTRACT_VERSION,
  moduleDefinitionToManifest,
  type ManifestEvents,
  type ManifestFrontend,
  type ManifestMountPoint,
  type ManifestDataSubject,
  type ManifestGrpcClient,
  type ManifestNotify,
  type ModuleKind,
  type ModuleManifestV1,
} from './module-manifest';
import { MODULE_REGISTRY, type JsonValue, type ModuleDefinition } from './module-registry';
import { assertReadOnlyModules } from './module-readonly';

/** Declarative (non-permission) core of a real manifest, keyed by module id. */
type RealManifestCore = {
  version: string;
  kind: ModuleKind;
  platformApi: string;
  icon?: string;
  helpUrl?: string;
  alwaysEnabled?: boolean;
  dataSubjects?: ManifestDataSubject[];
  events?: ManifestEvents;
  frontend?: ManifestFrontend;
  /** gRPC service name (FR-MOD-23) — gateway client generation. */
  grpcService?: string;
  /** Gateway gRPC client registration descriptor (FR-MOD-23). */
  grpcClient?: ManifestGrpcClient;
  /** Notification semantics for emitted events (RFC-2 §1.7 / FR-NOTIF-210). */
  notify?: ManifestNotify;
  /** Module settings JSON Schema when it differs from registry shorthand (FR-DEALS-530). */
  settingsSchema?: JsonValue;
};

/**
 * Build a gateway gRPC client descriptor (FR-MOD-23) from compact parts. The
 * proto file lives at `<dir>/v1/<dir>.proto` and the URL config key is
 * `app.grpc.<configBase>Url`; both follow the AS-IS `grpc-bff.module.ts` layout.
 */
function grpcClient(
  token: string,
  pkg: string,
  protoDir: string,
  configBase: string,
  defaultUrl: string,
): ManifestGrpcClient {
  return {
    token,
    package: pkg,
    protoPath: [protoDir, 'v1', `${protoDir}.proto`],
    urlConfigKey: `app.grpc.${configBase}Url`,
    defaultUrl,
  };
}

const VENDOR = { name: 'Fairflow', type: 'first_party' as const };

/**
 * Build a host navigation entry from a path/label/icon and an optional gate.
 * Keeps the real manifests declarative and compact.
 */
function nav(path: string, label: string, icon: string, requires?: string): ManifestFrontend {
  return { navigation: [{ path, label, icon, requires }] };
}

/**
 * TODO-450: build a `frontend` block that has BOTH host navigation and host
 * mount-points (slot contributions).
 *
 * Until now every real manifest declared navigation only, so
 * `manifestToNavCard` always produced `mountPoints: []` and the whole slot
 * machinery downstream (`GET /api/v1/platform/modules` → `useSlotContributions`
 * → `<Slot>` → the federated expose) had nothing to render: the contributions
 * were written, exposed and bundled but never reached the user.
 *
 * `slot` MUST be a member of the host SLOT_CATALOG (RFC-3 §1.2) and the
 * module's `kind` must be allowed to contribute there, otherwise both the
 * backend validator and the host drop the contribution.
 */
function navWithMounts(
  base: ManifestFrontend,
  mountPoints: ManifestMountPoint[],
): ManifestFrontend {
  return { ...base, mountPoints };
}

/** FR-SHELL-270 / FR-MOD-28: quick-create types from manifest `drawerEntities[]`. */
function withDrawerEntities(
  base: ManifestFrontend,
  drawerEntities: string[],
): ManifestFrontend {
  return { ...base, drawerEntities };
}

function navDrawerMounts(
  base: ManifestFrontend,
  drawerEntities: string[],
  mountPoints: ManifestMountPoint[],
): ManifestFrontend {
  return { ...base, drawerEntities, mountPoints };
}

/**
 * Real declarative manifests for every 1st-party/system module in the registry.
 * `frontend.navigation` is the manifest-driven menu (FR-MOD-28 — replaces the
 * synthesized single default); `dataSubjects` drive ownership/visibility
 * inheritance (FR-MOD-21); `events.emits/listens` are the event contract
 * (FR-MOD-24, namespaced `crm.*` for the CRM cluster, own-namespace otherwise).
 */
const REAL_MANIFEST_CORES: Record<string, RealManifestCore> = {
  statistics: {
    version: '1.0.0',
    kind: 'system',
    alwaysEnabled: true,
    platformApi: '^1',
    icon: 'PiChartLineUp',
    // FR-STAT-030: read-only module — no owned store / dataSubjects.
    dataSubjects: [],
    frontend: navWithMounts(
      nav('/statistics', 'Статистика', 'PiChartLineUp', 'statistics:read'),
      [
        {
          slot: 'dashboard.kpi.cell',
          component: 'DashboardKpiMount',
          requires: 'statistics:read',
          requiresContext: ['projectId', 'period'],
          order: 100,
        },
        {
          slot: 'dashboard.widget',
          component: 'DashboardChartsMount',
          requires: 'statistics:read',
          requiresContext: ['projectId', 'period'],
          order: 100,
        },
        {
          slot: 'dashboard.list',
          component: 'DashboardListsMount',
          requires: 'statistics:read',
          requiresContext: ['projectId', 'period'],
          order: 100,
        },
      ],
    ),
    events: { listens: ['crm.deal.created', 'crm.deal.stage_changed', 'crm.order.created'] },
  },
  contacts: {
    version: '1.0.0',
    kind: 'business',
    platformApi: '^1',
    icon: 'PiUsers',
    frontend: navDrawerMounts(
      nav('/contacts', 'Контакты', 'PiUsers', 'contacts:read'),
      ['contact'],
      [
        {
          slot: 'company.card.tab',
          component: 'CompanyCardContactsTab',
          requires: 'contacts:read',
          requiresContext: ['companyId'],
          order: 50,
        },
        {
          slot: 'deal.card.tab',
          component: 'DealCardContactTab',
          requires: 'contacts:read',
          requiresContext: ['dealId', 'contactId'],
          order: 50,
        },
        {
          slot: 'project.settings.tab',
          component: 'ContactsSettingsTab',
          requires: 'project:manage',
          requiresContext: ['projectId'],
          order: 110,
        },
      ],
    ),
    grpcService: 'ContactService',
    grpcClient: grpcClient('CONTACT_GRPC', 'fairflow.contact.v1', 'contact', 'contact', '127.0.0.1:5003'),
    dataSubjects: [
      {
        resource: 'contacts',
        ownable: true,
        shareable: true,
        ownerField: 'ownerId',
        departmentField: 'departmentId',
        abacBackend: 'mongo',
      },
    ],
    events: {
      emits: ['crm.contact.created', 'crm.contact.updated', 'crm.contact.deleted', 'crm.contact.merged'],
      listens: ['crm.company.merged'],
    },
  },
  companies: {
    version: '1.0.0',
    kind: 'business',
    platformApi: '^1',
    icon: 'PiBuildings',
    frontend: navDrawerMounts(
      nav('/companies', 'Клиенты', 'PiBuildings', 'companies:read'),
      ['company'],
      [
        {
          slot: 'contact.card.tab',
          component: 'ContactCompaniesTab',
          requires: 'companies:read',
          requiresContext: ['contactId'],
          order: 50,
        },
        {
          slot: 'deal.card.sidebar',
          component: 'DealCompanySidebar',
          requires: 'companies:read',
          requiresContext: ['dealId'],
          order: 50,
        },
        {
          slot: 'order.card.tab',
          component: 'OrderCompanyTab',
          requires: 'companies:read',
          requiresContext: ['orderId'],
          order: 50,
        },
        {
          slot: 'global.drawer.entity',
          component: 'CompanyQuickCreatePanel',
          requires: 'companies:write',
          requiresContext: ['entityType'],
          order: 50,
        },
      ],
    ),
    grpcService: 'CompanyService',
    grpcClient: grpcClient('COMPANY_GRPC', 'fairflow.company.v1', 'company', 'company', '127.0.0.1:5004'),
    dataSubjects: [
      { resource: 'companies', ownable: true, shareable: true, ownerField: 'ownerId', abacBackend: 'mongo' },
    ],
    events: {
      emits: ['crm.company.created', 'crm.company.updated', 'crm.company.deleted', 'crm.company.merged'],
      listens: [
        'crm.contact.updated',
        'crm.contact.deleted',
        'crm.contact.merged',
        'crm.company.contact_linked',
        'crm.company.contact_unlinked',
        'control.member.offboarded',
      ],
    },
  },
  deals: {
    version: '1.0.0',
    kind: 'business',
    platformApi: '^1',
    alwaysEnabled: true,
    icon: 'PiKanban',
    frontend: navDrawerMounts(nav('/deals', 'Сделки', 'PiKanban', 'deals:read'), ['deal'], [
      {
        slot: 'contact.card.tab',
        component: 'DealsCardTab',
        requires: 'deals:read',
        requiresContext: ['contactId'],
        order: 50,
      },
      {
        slot: 'company.card.tab',
        component: 'DealsCardTab',
        requires: 'deals:read',
        requiresContext: ['companyId'],
        order: 50,
      },
    ]),
    // The deals module is served by the `pipe` domain (PIPE_GRPC / fairflow.pipe.v1).
    grpcService: 'PipeService',
    grpcClient: grpcClient('PIPE_GRPC', 'fairflow.pipe.v1', 'pipe', 'pipe', '127.0.0.1:5005'),
    dataSubjects: [
      {
        resource: 'deals',
        ownable: true,
        shareable: true,
        ownerField: 'assigneeId',
        departmentField: 'departmentId',
        abacBackend: 'mongo',
        abacFields: [
          'amount',
          'stageId',
          'pipelineId',
          'source',
          'status',
          'assigneeId',
          'departmentId',
          'currency',
          'probability',
        ],
      },
    ],
    events: {
      emits: [
        'crm.deal.created',
        'crm.deal.updated',
        'crm.deal.deleted',
        'crm.deal.restored',
        'crm.deal.stage_changed',
        'crm.deal.won',
        'crm.deal.lost',
        'crm.deal.reopened',
        'crm.deal.reassigned',
        'crm.deal.drift_accepted',
        'crm.deal.product_linked',
        'crm.deal.product_unlinked',
        'crm.contact.deal_attached',
        'crm.company.deal_attached',
      ],
      listens: ['crm.contact.updated', 'crm.company.updated', 'control.member.offboarded'],
    },
    settingsSchema: {
      type: 'object',
      properties: {
        defaultBoard: {
          type: 'array',
          items: { type: 'string', enum: ['kanban', 'list'] },
        },
        stageSyncEnabled: { type: 'boolean' },
      },
    },
    notify: {
      events: [
        {
          eventType: 'crm.deal.reassigned',
          category: 'deals',
          severity: 'info',
          defaultChannels: ['in_app'],
          addressee: 'owner',
          i18n: {
            title: { ru: 'Вам назначена сделка', en: 'Deal reassigned to you' },
            body: {
              ru: 'Сделка {{entityLabel}} переведена на вас',
              en: 'Deal {{entityLabel}} has been reassigned to you',
            },
          },
        },
        {
          eventType: 'crm.deal.stage_changed',
          category: 'deals',
          severity: 'info',
          defaultChannels: ['in_app'],
          addressee: 'owner',
          i18n: {
            title: { ru: 'Стадия сделки изменена', en: 'Deal stage changed' },
            body: {
              ru: 'Сделка {{entityLabel}} переведена на новую стадию',
              en: 'Deal {{entityLabel}} moved to a new stage',
            },
          },
        },
        {
          eventType: 'crm.deal.won',
          category: 'deals',
          severity: 'important',
          defaultChannels: ['in_app'],
          addressee: 'owner',
          i18n: {
            title: { ru: 'Сделка выиграна', en: 'Deal won' },
            body: {
              ru: 'Сделка {{entityLabel}} закрыта как выигранная',
              en: 'Deal {{entityLabel}} closed as won',
            },
          },
        },
        {
          eventType: 'crm.deal.lost',
          category: 'deals',
          severity: 'info',
          defaultChannels: ['in_app'],
          addressee: 'owner',
          i18n: {
            title: { ru: 'Сделка проиграна', en: 'Deal lost' },
            body: {
              ru: 'Сделка {{entityLabel}} закрыта как проигранная',
              en: 'Deal {{entityLabel}} closed as lost',
            },
          },
        },
        {
          eventType: 'crm.deal.reopened',
          category: 'deals',
          severity: 'info',
          defaultChannels: ['in_app'],
          addressee: 'owner',
          i18n: {
            title: { ru: 'Сделка возобновлена', en: 'Deal reopened' },
            body: {
              ru: 'Сделка {{entityLabel}} возобновлена',
              en: 'Deal {{entityLabel}} reopened',
            },
          },
        },
      ],
    },
  },
  orders: {
    version: '1.0.0',
    kind: 'business',
    platformApi: '^1',
    icon: 'PiReceipt',
    frontend: navDrawerMounts(nav('/orders', 'Продажи', 'PiReceipt', 'orders:read'), ['order'], [
      {
        slot: 'deal.card.action',
        component: 'DealCreateOrderAction',
        requires: 'orders:write',
        requiresContext: ['dealId'],
        order: 100,
      },
      {
        slot: 'list.action.menu',
        component: 'OrderListActionMenu',
        requires: 'orders:write',
        requiresContext: ['entityType', 'recordId'],
        order: 100,
      },
      {
        slot: 'list.bulk.action',
        component: 'OrderListBulkActionMenu',
        requires: 'orders:write',
        requiresContext: ['entityType', 'selectedIds'],
        order: 100,
      },
    ]),
    grpcService: 'OrdersService',
    grpcClient: grpcClient('ORDERS_GRPC', 'fairflow.orders.v1', 'orders', 'orders', '127.0.0.1:5006'),
    dataSubjects: [
      { resource: 'orders', ownable: true, shareable: true, ownerField: 'assigneeId', abacBackend: 'mongo' },
    ],
    events: {
      emits: ['crm.order.created', 'crm.order.updated', 'crm.order.status_changed', 'crm.order.stage_changed'],
      listens: ['crm.deal.won', 'crm.contact.merged', 'crm.company.merged'],
    },
    notify: {
      events: [
        {
          eventType: 'crm.order.final_action_failed',
          category: 'sales',
          severity: 'critical',
          defaultChannels: ['in_app', 'email'],
          addressee: 'owner',
          fanout: ['pa', 'leader'],
          i18n: {
            title: { ru: 'Ошибка оформления заказа', en: 'Order final action failed' },
            body: {
              ru: 'Финальное действие по заказу {{entityLabel}} не выполнено',
              en: 'Final action for order {{entityLabel}} failed',
            },
          },
        },
      ],
    },
  },
  activities: {
    version: '1.0.0',
    kind: 'business',
    platformApi: '^1',
    icon: 'PiCalendarCheck',
    // TODO-450: the activities module contributes the timeline tab to every
    // entity card (one implementation parameterised by the slot's entity-ref
    // context prop — see ActivityCardTab.resolveRef) and the "overdue" widget to
    // the dashboard. Both exposes are already wired in the host
    // (`loadRemoteComponent.slotComponentMap`) and bundled by
    // `modules/activities/vite.config.ts`.
    frontend: navDrawerMounts(
      nav('/activities', 'Активности', 'PiCalendarCheck', 'activities:read'),
      ['task', 'call', 'meeting', 'note'],
      [
        {
          slot: 'contact.card.tab',
          component: 'ActivityCardTab',
          requires: 'activities:read',
          requiresContext: ['contactId'],
          order: 100,
        },
        {
          slot: 'company.card.tab',
          component: 'ActivityCardTab',
          requires: 'activities:read',
          requiresContext: ['companyId'],
          order: 100,
        },
        {
          slot: 'deal.card.tab',
          component: 'ActivityCardTab',
          requires: 'activities:read',
          requiresContext: ['dealId'],
          order: 100,
        },
        {
          slot: 'order.card.tab',
          component: 'ActivityCardTab',
          requires: 'activities:read',
          requiresContext: ['orderId'],
          order: 100,
        },
        {
          slot: 'contact.card.sidebar',
          component: 'ActivityNextStepSidebar',
          requires: 'activities:read',
          requiresContext: ['contactId'],
          order: 100,
        },
        {
          slot: 'company.card.sidebar',
          component: 'ActivityNextStepSidebar',
          requires: 'activities:read',
          requiresContext: ['companyId'],
          order: 100,
        },
        {
          slot: 'deal.card.sidebar',
          component: 'ActivityNextStepSidebar',
          requires: 'activities:read',
          requiresContext: ['dealId'],
          order: 100,
        },
        {
          slot: 'list.action.menu',
          component: 'EntityListActionMenu',
          requires: 'activities:write',
          requiresContext: ['entityType', 'recordId'],
          order: 100,
        },
        {
          slot: 'list.bulk.action',
          component: 'EntityListBulkActionMenu',
          requires: 'activities:write',
          requiresContext: ['entityType', 'selectedIds'],
          order: 100,
        },
        {
          slot: 'dashboard.widget',
          component: 'ActivityOverdueWidget',
          requires: 'activities:read',
          requiresContext: ['projectId'],
          order: 200,
        },
      ],
    ),
    grpcService: 'ActivityService',
    grpcClient: grpcClient('ACTIVITY_GRPC', 'fairflow.activity.v1', 'activity', 'activity', '127.0.0.1:5008'),
    dataSubjects: [
      { resource: 'activities', ownable: true, shareable: true, ownerField: 'ownerId', abacBackend: 'mongo' },
    ],
    events: {
      emits: ['crm.activity.created', 'crm.activity.updated', 'crm.activity.completed'],
      listens: ['crm.deal.created', 'crm.deal.stage_changed', 'crm.company.merged'],
    },
  },
  products: {
    version: '1.0.0',
    kind: 'business',
    platformApi: '^1',
    icon: 'PiPackage',
    frontend: nav('/products', 'Продукты', 'PiPackage', 'products:read'),
    grpcService: 'ProductService',
    grpcClient: grpcClient('PRODUCT_GRPC', 'fairflow.product.v1', 'product', 'product', '127.0.0.1:5007'),
    dataSubjects: [
      { resource: 'products', ownable: false, shareable: false, abacBackend: 'mongo' },
    ],
    events: { emits: ['crm.product.created', 'crm.product.updated', 'crm.product.deleted'] },
  },
  reports: {
    version: '1.0.0',
    kind: 'business',
    platformApi: '^1',
    icon: 'PiChartBar',
    frontend: navWithMounts(
      nav('/reports', 'Отчёты', 'PiChartBar', 'reports:read'),
      [
        {
          slot: 'deal.card.tab',
          component: 'MiniReportWidget',
          requires: 'reports:read',
          requiresContext: ['dealId'],
          order: 50,
        },
        {
          slot: 'company.card.tab',
          component: 'MiniReportWidget',
          requires: 'reports:read',
          requiresContext: ['companyId'],
          order: 50,
        },
      ],
    ),
    grpcService: 'ReportsService',
    grpcClient: grpcClient('REPORTS_GRPC', 'fairflow.reports.v1', 'reports', 'reports', '127.0.0.1:5011'),
    // reports is an on-demand composer (no owned store) — emits run/export facts.
    // Canon (RFC-4 §3.8): `report.generated` on Run, `statistics.exported` on
    // Export (there is no `report.exported` key — audit binds `statistics.*`).
    events: {
      emits: ['report.generated', 'statistics.exported'],
      listens: ['crm.deal.created', 'crm.order.created', 'crm.contact.created', 'crm.company.created'],
    },
  },
  documents: {
    version: '1.0.0',
    kind: 'business',
    platformApi: '^1',
    icon: 'PiFiles',
    frontend: navWithMounts(
      nav('/documents', 'Документы', 'PiFiles', 'documents:read'),
      [
        {
          slot: 'project.settings.tab',
          component: 'DocumentsSettingsTab',
          requires: 'project:manage',
          requiresContext: ['projectId'],
          order: 110,
        },
      ],
    ),
    grpcService: 'DocumentsService',
    grpcClient: grpcClient('DOCUMENTS_GRPC', 'fairflow.documents.v1', 'documents', 'documents', '127.0.0.1:5010'),
    events: {
      emits: ['document.generated', 'document.uploaded', 'document.deleted'],
      listens: ['crm.order.document_requested'],
    },
  },
  automation: {
    version: '1.0.0',
    kind: 'business',
    platformApi: '^1',
    icon: 'PiLightning',
    frontend: navWithMounts(
      nav('/automation', 'Автоматизация', 'PiLightning', 'automation:read'),
      [
        {
          slot: 'nav.item.badge',
          component: 'NavDlqBadge',
          requires: 'automation:manage',
          requiresContext: ['moduleId'],
          order: 10,
        },
        {
          slot: 'contact.card.tab',
          component: 'EntityRuleHistoryTab',
          requires: 'automation:read',
          requiresContext: ['contactId'],
          order: 30,
        },
        {
          slot: 'deal.card.tab',
          component: 'EntityRuleHistoryTab',
          requires: 'automation:read',
          requiresContext: ['dealId'],
          order: 30,
        },
        {
          slot: 'order.card.tab',
          component: 'EntityRuleHistoryTab',
          requires: 'automation:read',
          requiresContext: ['orderId'],
          order: 30,
        },
      ],
    ),
    grpcService: 'AutomationService',
    grpcClient: grpcClient('AUTOMATION_GRPC', 'fairflow.automation.v1', 'automation', 'automation', '127.0.0.1:5012'),
    events: {
      emits: [
        'automation.rule.created',
        'automation.rule.updated',
        'automation.rule.deleted',
        'automation.rule.executed',
        'automation.action.failed',
        'automation.dlq.exhausted',
      ],
      listens: [
        'crm.deal.created',
        'crm.deal.stage_changed',
        'crm.activity.created',
        'crm.order.status_changed',
      ],
    },
    notify: {
      events: [
        {
          eventType: 'automation.dlq.exhausted',
          category: 'data',
          severity: 'critical',
          defaultChannels: ['in_app', 'email'],
          fanout: ['pa'],
          i18n: {
            title: { ru: 'Автоматизация: исчерпаны повторы', en: 'Automation retries exhausted' },
            body: {
              ru: 'Действие правила не удалось после всех попыток',
              en: 'Rule action failed after all retries',
            },
          },
        },
      ],
    },
  },
  /**
   * TODO-276 (ui-shell): `kind:'system'` — search participates in portfolio chrome
   * routes and host-only slots (`shell.header.action`). `isModuleLocked` therefore
   * treats search as non-removable (RFC-2), matching statistics/notifications.
   *
   * TODO-277: both UX contributions from `ux/screens/search/SCREENS.md` §C are
   * declared here so `GET /api/v1/platform/modules` → `useSlotContributions` can
   * surface them. `shell.header.action` is `host-only` (system modules only,
   * RFC-3 §1.3); runtime chrome still uses host `Search.tsx` until TODO-278 wires
   * `<Slot id="shell.header.action">`.
   */
  search: {
    version: '1.0.0',
    kind: 'system',
    platformApi: '^1',
    icon: 'PiMagnifyingGlass',
    frontend: navWithMounts(
      nav('/search', 'Поиск', 'PiMagnifyingGlass', 'search:read'),
      [
        {
          slot: 'shell.header.action',
          component: 'GlobalSearchDialog',
          order: 10,
        },
        {
          slot: 'project.settings.tab',
          component: 'SearchSettingsTab',
          requires: 'project:manage',
          requiresContext: ['projectId'],
          order: 100,
        },
      ],
    ),
    grpcService: 'SearchService',
    grpcClient: grpcClient('SEARCH_GRPC', 'fairflow.search.v1', 'search', 'search', '127.0.0.1:5013'),
    events: {
      listens: [
        'crm.contact.created',
        'crm.company.created',
        'crm.deal.created',
        'crm.contact.updated',
        'crm.company.updated',
        'crm.deal.updated',
      ],
    },
  },
  /**
   * TODO-278 (ui-shell): host-only chrome slots (`shell.header.action`,
   * `account.menu.item`) and open `nav.item.badge` are declared here so
   * `GET /api/v1/platform/modules` → `useSlotContributions` can mount the
   * host-local chrome components wired in `loadRemoteComponent.hostLocalSlotMap`.
   */
  notifications: {
    version: '1.0.0',
    kind: 'system',
    alwaysEnabled: true,
    platformApi: '^1',
    icon: 'PiBell',
    frontend: navWithMounts(
      nav('/notifications', 'Уведомления', 'PiBell', 'notifications:read'),
      [
        {
          slot: 'shell.header.action',
          component: 'HeaderNotificationBell',
          order: 30,
        },
        {
          slot: 'nav.item.badge',
          component: 'NavItemBadge',
          order: 10,
        },
        {
          slot: 'account.menu.item',
          component: 'AccountMenuItem',
          order: 100,
        },
      ],
    ),
    grpcService: 'NotificationService',
    grpcClient: grpcClient('NOTIFICATION_GRPC', 'fairflow.notification.v1', 'notification', 'notification', '127.0.0.1:5015'),
    events: {
      listens: ['crm.deal.stage_changed', 'crm.order.status_changed', 'crm.deal.assigned'],
    },
  },
  /**
   * FR-PROFILE-320 / global.drawer.entity: system profile module contributes the
   * colleague mini-profile drawer (`entityType=user`). Host-local component.
   */
  profile: {
    version: '1.0.0',
    kind: 'system',
    alwaysEnabled: true,
    platformApi: '^1',
    icon: 'PiUser',
    frontend: navDrawerMounts({ navigation: [] }, ['user'], [
      {
        slot: 'global.drawer.entity',
        component: 'UserProfileDrawer',
        requiresContext: ['entityType', 'entityId'],
        order: 10,
      },
    ]),
  },
  chat: {
    version: '1.0.0',
    kind: 'business',
    platformApi: '^1',
    icon: 'PiChatCircle',
    frontend: nav('/chat', 'Чат', 'PiChatCircle', 'chat:read'),
    // M-CHAT-2/5: backend block → hasBackend=true → gateway auto-generates the
    // gRPC client via listGatewayGrpcClients (FR-MOD-23), no manual grpc-bff edit.
    grpcService: 'ChatService',
    grpcClient: grpcClient('CHAT_GRPC', 'fairflow.chat.v1', 'chat', 'chat', '127.0.0.1:5017'),
    dataSubjects: [
      // scope-owned (contracts/chat.md §6): visibility via conversation_members,
      // not via an ABAC predicate on the record. shareable=false.
      { resource: 'conversations', ownable: true, shareable: false, ownerField: 'scope.scopeId', abacBackend: 'mongo' },
      { resource: 'messages', ownable: true, shareable: false, ownerField: 'senderId', abacBackend: 'mongo' },
    ],
    events: {
      // chat emits durable facts via outbox; notification/audit consume
      // chat.message.created. @mention is a field, not a separate key (B-2).
      emits: [
        'chat.message.created',
        'chat.message.edited',
        'chat.message.deleted',
        'chat.conversation.created',
        'chat.member.added',
        'chat.member.removed',
      ],
      listens: [],
    },
  },
};

/**
 * Build the full `ModuleManifestV1` for a registry definition: the real
 * declarative core (above) merged with the registry-derived `permissions`,
 * `settingsSchema`, `displayName`, `description` and `dependsOn`. Permissions and
 * settings keep flowing from `policyCapabilities`/settings schemas so the
 * existing catalog/auto-form are untouched (non-breaking).
 */
function buildRealManifest(def: ModuleDefinition, core: RealManifestCore): ModuleManifestV1 {
  // Reuse the legacy bridge ONLY to derive permissions + settingsSchema; the rest
  // (version/kind/vendor/platformApi/frontend/dataSubjects/events) comes from the
  // real declarative core, not synthesized defaults.
  const bridged = moduleDefinitionToManifest(def);
  // Backend block is present when the module has a domain (gRPC client) and/or an
  // event contract. `grpcService`/`grpcClient` drive gateway client generation
  // (FR-MOD-23); `events` is the publish/subscribe contract (FR-MOD-24).
  const hasBackend = Boolean(core.grpcService || core.grpcClient || core.events);
  return {
    contractVersion: MANIFEST_CONTRACT_VERSION,
    id: def.id,
    version: core.version,
    kind: core.kind,
    vendor: VENDOR,
    platformApi: core.platformApi,
    displayName: def.name,
    description: def.description,
    icon: core.icon,
    helpUrl: core.helpUrl,
    alwaysEnabled: core.alwaysEnabled ?? (def.locked || undefined),
    dependsOn: def.dependencies.length > 0 ? def.dependencies.slice() : undefined,
    // `softDependsOn` — из того же реестра (см. `moduleDefinitionToManifest`):
    // «использует, если включён», без авто-включения и каскадного выключения.
    softDependsOn: bridged.softDependsOn,
    permissions: bridged.permissions,
    dataSubjects: core.dataSubjects,
    backend: hasBackend
      ? {
          healthContract: 'ops-http-contract',
          grpcService: core.grpcService,
          grpcClient: core.grpcClient,
          events: core.events,
        }
      : undefined,
    frontend: core.frontend,
    settingsSchema: core.settingsSchema ?? bridged.settingsSchema,
    notify: core.notify,
  };
}

/**
 * Authoritative real `ModuleManifestV1` registry, keyed by module id. Built once
 * from the declarative cores + the module registry. Modules present in
 * `MODULE_REGISTRY` but without a real core fall back to the legacy bridge so the
 * map always covers every known module (fail-soft, FR-MOD-33).
 */
export const MODULE_MANIFESTS: Record<string, ModuleManifestV1> = Object.fromEntries(
  Object.values(MODULE_REGISTRY).map((def) => {
    const core = REAL_MANIFEST_CORES[def.id];
    return [def.id, core ? buildRealManifest(def, core) : moduleDefinitionToManifest(def)];
  }),
);

// FR-STAT-030: fail-closed at registry build — read-only modules cannot drift.
assertReadOnlyModules(MODULE_MANIFESTS);

/**
 * Resolve the authoritative manifest for a module id. Returns the real manifest
 * when one exists, else the legacy bridge for an unknown/registry-only module
 * (so callers never get `undefined` for a registered module).
 */
export function getModuleManifest(moduleId: string): ModuleManifestV1 | undefined {
  const real = MODULE_MANIFESTS[moduleId];
  if (real) return real;
  const def = MODULE_REGISTRY[moduleId];
  return def ? moduleDefinitionToManifest(def) : undefined;
}

/** All real manifests as an array (catalog/generator consumers). */
export function listModuleManifests(): ModuleManifestV1[] {
  return Object.values(MODULE_MANIFESTS);
}
