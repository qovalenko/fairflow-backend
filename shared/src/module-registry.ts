import { moduleDefinitionToManifest, isWithinNamespace, normalizeAction } from './module-manifest';
import { buildPermissionCatalog, type PermissionCatalog } from './permission-catalog';
import { validateSettings } from './settings-schema';

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export type ModulePolicyCapability = {
  subject: string;
  actions: string[];
};

export type ModuleIntegrationMethod = {
  id: string;
  name: string;
  description: string;
  /** Legacy integration API surface — prefer policyCapabilities (FR-AUTOM-240). */
  deprecated?: boolean;
};

export type ModuleDefinition = {
  id: string;
  name: string;
  description: string;
  locked: boolean;
  /**
   * ЖЁСТКИЕ зависимости (манифест `dependsOn`). Ребро здесь — не документация,
   * а два рантайм-эффекта разом:
   *  - `resolveDependencies` ПРИНУДИТЕЛЬНО добавляет зависимость в эффективный
   *    набор модулей проекта (его же читают `GatewayModuleGuard` /
   *    `ProjectAccessGuard` → маршруты `@RequireModule(dep)` открываются);
   *  - `normalizeModuleConfigs` КАСКАДНО ГАСИТ зависимого, если зависимость
   *    выключена.
   * То есть жёсткое ребро молча переопределяет тумблер модуля в обе стороны.
   * Ставить его можно только там, где без донора модуль физически неработоспособен.
   */
  dependencies: string[];
  /**
   * МЯГКИЕ зависимости (манифест `softDependsOn`): «использует, если включён».
   * НЕ включаются автоматически и НЕ гасят зависимого каскадом — отсутствие
   * донора означает деградацию функции, а не отказ модуля (образец:
   * `documents` × `DOCUMENT_CONTEXT_TO_MODULE`, `orders` × `products` —
   * `donorGate`/`fillOrderNames` в `crm-bff.controller.ts` не опрашивает
   * выключенный модуль-донор и оставляет имя пустым).
   */
  softDependencies?: string[];
  integrationMethods: ModuleIntegrationMethod[];
  personalSettingsSchema: Record<string, JsonValue>;
  integrationSettingsSchema: Record<string, JsonValue>;
  /** Integration/personal setting keys that must be set before runtime starts (FR-LIFE-22). */
  requiredBeforeEnable?: string[];
  policyCapabilities: ModulePolicyCapability[];
};

export type ProjectModuleConfig = {
  moduleId: string;
  enabled: boolean;
  personalSettings: Record<string, JsonValue>;
  integrationSettings: Record<string, JsonValue>;
  integrationMethodsEnabled: string[];
  // Lifecycle (R4-E1-05, additive/optional — preserved by normalizeModuleConfigs):
  // `version` = active manifest version in the project; `installed` = present in
  // the space (installed) even when not enabled. Absent → derived defaults.
  version?: string;
  installed?: boolean;
  /** External delivery axis (§19e.5): active | suspended. */
  runtimeStatus?: 'active' | 'suspended';
  /** True after any disable/suspend — re-enable does not auto-resume runtime. */
  everSuspended?: boolean;
  /** Configuration completeness for enable (FR-LIFE-22). */
  configState?: 'ready' | 'needs_config';
};

export type ProjectModulePolicyRule = {
  id: string;
  moduleId: string;
  effect: 'allow' | 'deny';
  subject: string;
  action: string;
  resource: string;
  condition: Record<string, JsonValue>;
};

function emptySchema(): Record<string, JsonValue> {
  return {};
}

function integrationMethods(
  ...items: Array<{ id: string; name: string; description: string; deprecated?: boolean }>
) {
  return items.map((item) => ({ ...item, deprecated: item.deprecated ?? true }));
}

function capabilities(...items: Array<{ subject: string; actions: string[] }>) {
  return items;
}

const MODULES: ModuleDefinition[] = [
  {
    id: 'statistics',
    name: 'Статистика',
    description: 'Дашборд и аналитика',
    locked: true,
    dependencies: [],
    // FR-STAT-040: канон — `statistics:read` / `statistics:export` в policyCapabilities;
    // dotted-id `statistics.read.*` в integrationMethods больше не объявляем.
    integrationMethods: integrationMethods(),
    personalSettingsSchema: emptySchema(),
    integrationSettingsSchema: emptySchema(),
    policyCapabilities: capabilities(
      // `export` — отдельное право на выгрузку сводки (FR-MSTAT-10): его требует
      // и PEP (`@RequirePermission('statistics','export')` на
      // GET /api/v1/statistics/export), и кнопка «Экспорт» на аналитике. Пары не
      // было в каталоге → expandSystemRolePermissions её не эмитил (каталог —
      // единственный источник ключей), `statistics:export` не попадал в
      // allowed[] НИ У КОГО, включая owner, и кнопка была disabled у всех;
      // resolveDecoratorPermission по той же причине вернул бы null
      // (PERMISSION_MAPPING_MISSING), как только PEP переедет на каталожный путь.
      // Аналитический экспорт остаётся элевированным: `statistics` входит в
      // ELEVATED_EXPORT_SUBJECTS (permission-rbac.ts), поэтому member/viewer его
      // не получают — ключ появляется у manager и выше.
      { subject: 'statistics', actions: ['read', 'export'] },
      { subject: 'statistics.widget', actions: ['read'] },
    ),
  },
  {
    id: 'contacts',
    name: 'Контакты',
    description: 'Управление контактами',
    locked: false,
    dependencies: [],
    integrationMethods: integrationMethods(
      { id: 'contacts.read', name: 'Чтение контактов', description: 'Получение списка и карточки контакта' },
      { id: 'contacts.write', name: 'Изменение контактов', description: 'Создание и обновление контактов' },
    ),
    personalSettingsSchema: {
      defaultView: ['list', 'grid'],
      // FR-CONTACTS-520: per-project (stored on moduleConfig.personalSettings —
      // same store as GET/PUT /projects/:id/modules/:moduleId/settings).
      defaultCountry: 'string',
      trashTtlDays: 'number',
      shadowTtlDays: 'number',
      driftDetectionEnabled: 'boolean',
    },
    integrationSettingsSchema: { webhookUrl: 'string', syncIntervalMinutes: 'number' },
    policyCapabilities: capabilities(
      { subject: 'contacts', actions: ['read', 'write', 'delete', 'manage', 'export', 'import'] },
      { subject: 'contacts.integration', actions: ['invoke'] },
    ),
  },
  {
    id: 'companies',
    name: 'Клиенты',
    description: 'Управление компаниями',
    locked: false,
    dependencies: [],
    integrationMethods: integrationMethods(
      { id: 'companies.read', name: 'Чтение компаний', description: 'Получение списка и карточки компании' },
      { id: 'companies.write', name: 'Изменение компаний', description: 'Создание и обновление компаний' },
    ),
    personalSettingsSchema: { tableDensity: ['comfortable', 'compact'] },
    integrationSettingsSchema: { outboundTopic: 'string' },
    policyCapabilities: capabilities(
      { subject: 'companies', actions: ['read', 'write', 'delete', 'manage', 'export', 'import'] },
      // Переназначение владельца (TODO-366, FR-COMPANIES-300/-400). Ключ
      // `companies.owner:write` уже используют обе стороны: FE гейтит кнопку
      // «Сменить владельца» (CompanyDetails.tsx) и на него ссылается
      // DECORATOR_SUBJECT_MAP (`companies:reassign`, permission-rbac.ts) — но
      // в каталоге субъекта не было, поэтому проекция allowed[] его не отдавала
      // НИКОМУ (включая владельца проекта) и кнопка была скрыта у всех, хотя
      // PATCH /companies/:id/owner работал по `companies:write`. Прецедент —
      // `documents.generate:execute`. Действие `write` не элевировано, поэтому
      // системная раскрутка ролей выдаёт ключ ровно тем, кто и так проходит
      // серверный гейт (owner/admin/manager/member), а viewer — нет.
      { subject: 'companies.owner', actions: ['write'] },
      { subject: 'companies.integration', actions: ['invoke'] },
    ),
  },
  {
    id: 'deals',
    name: 'Сделки',
    description: 'Воронка продаж и сделки',
    locked: true,
    dependencies: [],
    integrationMethods: integrationMethods(
      { id: 'deals.read', name: 'Чтение сделок', description: 'Получение списка и карточек сделок' },
      { id: 'deals.write', name: 'Изменение сделок', description: 'Создание/обновление сделок и стадий' },
    ),
    personalSettingsSchema: { defaultBoard: ['kanban', 'list'] },
    integrationSettingsSchema: { stageSyncEnabled: 'boolean' },
    policyCapabilities: capabilities(
      { subject: 'deals', actions: ['read', 'write', 'delete', 'manage', 'export', 'import'] },
      { subject: 'deals.stage', actions: ['move'] },
      { subject: 'deals.integration', actions: ['invoke'] },
    ),
  },
  {
    id: 'orders',
    name: 'Продажи',
    description: 'Обработка продаж и документооборот',
    locked: false,
    // FR-ORDERS-495: манифест orders декларирует связку с [deals, products].
    // Направление ребра именно такое (каталог — донор позиций продажи, а не
    // наоборот; обратное ребро products → orders снято, см. products ниже,
    // TODO-098), но РАЗНОЙ жёсткости:
    //  - deals — жёстко: продажа живёт в контексте сделки;
    //  - products — МЯГКО. Жёсткое ребро здесь было бы тихим переопределением
    //    тумблера: `resolveDependencies` втащил бы products в эффективный набор
    //    любого проекта с включёнными «Продажами», и маршруты
    //    `@RequireModule('products')` (GET/POST /v1/products, категории, импорт
    //    каталога) открылись бы владельцу, который каталог явно выключил; а
    //    выключение каталога, наоборот, каскадом погасило бы сами «Продажи».
    //    Функционально orders без каталога работоспособен: типы продаж и сами
    //    продажи гейтятся `@RequireModule('orders')` (crm-bff.controller.ts),
    //    а обращения к донору products идут через `donorGate`/`fillOrderNames`,
    //    который выключенный модуль-донор не опрашивает вовсе (имя продукта
    //    остаётся пустым) — ровно контракт `softDependsOn`.
    dependencies: ['deals'],
    softDependencies: ['products'],
    integrationMethods: integrationMethods(
      { id: 'orders.read', name: 'Чтение продаж', description: 'Получение продаж и типов продаж' },
      { id: 'orders.write', name: 'Изменение продаж', description: 'Создание и обновление продаж' },
    ),
    personalSettingsSchema: { defaultTypeId: 'string' },
    integrationSettingsSchema: { erpWebhookUrl: 'string' },
    policyCapabilities: capabilities(
      // `move` required by MoveOrderToStage (contract orders.md §1, gate 11/13) — WM2.
      { subject: 'orders', actions: ['read', 'write', 'delete', 'move', 'manage', 'export', 'import'] },
      { subject: 'orders.integration', actions: ['invoke'] },
    ),
  },
  {
    id: 'activities',
    name: 'Активности',
    description: 'Задачи, звонки, встречи',
    locked: false,
    dependencies: ['deals'],
    integrationMethods: integrationMethods(
      { id: 'activities.read', name: 'Чтение активностей', description: 'Получение задач/встреч/звонков' },
      { id: 'activities.write', name: 'Изменение активностей', description: 'Создание и обновление активностей' },
    ),
    personalSettingsSchema: {
      defaultCalendarView: ['week', 'month'],
      defaultReminder: ['none', 'at_time', '15m', '1h', '1d'],
    },
    integrationSettingsSchema: { remindersWebhookUrl: 'string' },
    policyCapabilities: capabilities(
      { subject: 'activities', actions: ['read', 'write', 'delete', 'manage', 'export'] },
      { subject: 'activities.integration', actions: ['invoke'] },
    ),
  },
  {
    id: 'products',
    name: 'Продукты',
    description: 'Каталог продуктов и услуг',
    locked: false,
    // TODO-098 / FR-ORDERS-495: каталог продуктов самостоятелен — он питает и
    // сделки, и продажи, поэтому жёсткое `['orders']` было обратным ребром
    // (выключение продаж каскадно гасило каталог). Реальная связка объявлена на
    // стороне orders и она мягкая: `softDependencies: ['products']`.
    dependencies: [],
    integrationMethods: integrationMethods(
      { id: 'products.read', name: 'Чтение продуктов', description: 'Получение каталога продуктов' },
      { id: 'products.write', name: 'Изменение продуктов', description: 'Создание и редактирование каталога' },
    ),
    // FR-PRODUCTS-050 / FR-MPRD-1b: валюта каталога — настройка уровня проекта
    // (integrationSettings), не персональная.
    personalSettingsSchema: emptySchema(),
    integrationSettingsSchema: {
      defaultCurrency: 'string',
      syncFromExternalCatalog: 'boolean',
    },
    policyCapabilities: capabilities(
      { subject: 'products', actions: ['read', 'write', 'delete', 'manage', 'export', 'import'] },
      { subject: 'products.integration', actions: ['invoke'] },
    ),
  },
  {
    id: 'reports',
    name: 'Отчёты',
    description: 'Аналитика и отчёты',
    locked: false,
    // FR-MREP-26 (B3): reports → statistics is a SOFT dependency, not hard.
    // reports aggregates pipe/orders/contact/company/activity on-demand and must
    // enable/run without statistics (no cascade-disable). A dedicated softDependsOn
    // manifest field is TO-BE (RFC-2 §П-5); for now the hard edge is removed.
    dependencies: [],
    integrationMethods: integrationMethods(
      { id: 'reports.export', name: 'Экспорт отчётов', description: 'Экспорт отчётов в внешние системы' },
    ),
    personalSettingsSchema: { pinnedReports: ['array'] },
    integrationSettingsSchema: { exportBucket: 'string' },
    policyCapabilities: capabilities(
      { subject: 'reports', actions: ['read', 'export', 'manage'] },
      { subject: 'reports.integration', actions: ['invoke'] },
    ),
  },
  {
    id: 'documents',
    name: 'Документы',
    description: 'Хранение документов',
    locked: false,
    // TODO-098 / FR-DOCS-320, FR-DOCS-330: зависимость documents от доноров —
    // МЯГКАЯ и per-context. Домен работает с contextType contact/company/deal/
    // order и 'none', донор контекста вычисляется таблицей
    // DOCUMENT_CONTEXT_TO_MODULE (document-context.ts) — выключенный донор просто
    // не предлагается при генерации, а чтение/скачивание уже выпущенных
    // документов не блокируется. Жёсткое `['orders']` гасило весь модуль
    // documents каскадом (normalizeModuleConfigs) — снято.
    dependencies: [],
    integrationMethods: integrationMethods(
      { id: 'documents.read', name: 'Чтение документов', description: 'Чтение документов по продажам' },
      { id: 'documents.write', name: 'Изменение документов', description: 'Загрузка и обновление документов' },
    ),
    // FR-DOCS-410: вкладка DocumentsSettingsTab пишет через
    // GET|PUT /projects/:id/modules/documents/settings → personalSettings.
    // sanitizeSettings оставляет только ключи этой схемы — все четыре поля
    // формы должны быть здесь, иначе storageProvider/maxTemplateSizeBytes
    // молча вырезаются при сохранении (как search.minQueryChars, FR-MSRCH-19).
    personalSettingsSchema: {
      folderView: ['tree', 'list'],
      downloadTtlSec: 'number',
      storageProvider: ['s3', 'minio'],
      maxTemplateSizeBytes: 'number',
    },
    integrationSettingsSchema: emptySchema(),
    policyCapabilities: capabilities(
      { subject: 'documents', actions: ['read', 'write', 'delete', 'manage'] },
      // Document issuing (generate/upload/regenerate) — the FE gates the buttons
      // on `documents.generate:execute` and the decorator map already resolves
      // `documents:generate` to it (permission-rbac.ts); without this entry the
      // key is absent from the catalog and NOBODY (incl. the owner) holds it.
      { subject: 'documents.generate', actions: ['execute'] },
      { subject: 'documents.integration', actions: ['invoke'] },
    ),
  },
  {
    id: 'automation',
    name: 'Автоматизация',
    description: 'Правила и триггеры',
    locked: false,
    dependencies: ['deals', 'activities'],
    integrationMethods: integrationMethods(
      { id: 'automation.trigger.execute', name: 'Запуск триггеров', description: 'Запуск автоматизаций извне' },
      { id: 'automation.rules.read', name: 'Чтение правил', description: 'Чтение правил автоматизации' },
    ),
    personalSettingsSchema: { notificationsEnabled: 'boolean' },
    integrationSettingsSchema: { defaultWebhookSecret: 'string' },
    requiredBeforeEnable: ['defaultWebhookSecret'],
    policyCapabilities: capabilities(
      { subject: 'automation', actions: ['read', 'write', 'delete', 'manage', 'execute'] },
      { subject: 'automation.integration', actions: ['invoke'] },
    ),
  },
  {
    id: 'search',
    name: 'Поиск',
    description: 'Глобальный поиск по проекту',
    locked: false,
    dependencies: ['contacts', 'companies', 'deals'],
    integrationMethods: integrationMethods(
      { id: 'search.query', name: 'Поисковый запрос', description: 'Поиск по сущностям проекта' },
    ),
    personalSettingsSchema: {
      defaultScope: ['all', 'contacts', 'companies', 'deals'],
      // U5 / FR-MSRCH-19: per-project search settings persist in project
      // moduleConfigs[search].personalSettings. sanitizeSettings keeps only keys
      // declared here, so every field the FE (SearchSettings) sends must be listed.
      minQueryChars: 'number',
      perTypeLimit: 'number',
      hotkeyEnabled: 'boolean',
      indexableTypes: ['array'],
      freshnessSlaMs: 'number',
    },
    integrationSettingsSchema: { indexRefreshSeconds: 'number' },
    policyCapabilities: capabilities(
      { subject: 'search', actions: ['read', 'manage'] },
      { subject: 'search.integration', actions: ['invoke'] },
    ),
  },
  {
    id: 'profile',
    name: 'Профиль',
    description: 'Личный кабинет пользователя (глобальный singleton)',
    locked: true,
    dependencies: [],
    integrationMethods: integrationMethods(),
    personalSettingsSchema: emptySchema(),
    integrationSettingsSchema: emptySchema(),
    policyCapabilities: capabilities(),
  },
  {
    id: 'notifications',
    name: 'Уведомления',
    description: 'Центр уведомлений',
    locked: true,
    dependencies: [],
    integrationMethods: integrationMethods(
      { id: 'notifications.send', name: 'Отправка уведомлений', description: 'Отправка событий в центр уведомлений' },
      { id: 'notifications.read', name: 'Чтение уведомлений', description: 'Получение списка уведомлений' },
    ),
    personalSettingsSchema: { emailDigest: ['immediate', 'hourly', 'daily', 'off'] },
    integrationSettingsSchema: { emailProvider: ['smtp', 'ses'] },
    policyCapabilities: capabilities(
      { subject: 'notifications', actions: ['read', 'write', 'manage'] },
      { subject: 'notifications.integration', actions: ['invoke'] },
    ),
  },
  {
    id: 'chat',
    name: 'Чат',
    description: 'Внутренний мессенджер',
    locked: false,
    dependencies: ['notifications'],
    integrationMethods: integrationMethods(
      { id: 'chat.message.send', name: 'Отправка сообщений', description: 'Отправка сообщений из внешних интеграций' },
      { id: 'chat.message.read', name: 'Чтение сообщений', description: 'Чтение сообщений/каналов' },
    ),
    personalSettingsSchema: { compactMode: 'boolean' },
    integrationSettingsSchema: { botWebhookUrl: 'string' },
    policyCapabilities: capabilities(
      // M-CHAT-11 / FR-CHAT-49: `moderate` = edit/delete OTHER users' messages
      // (department head). `write` stays self-scoped (own messages only).
      { subject: 'chat', actions: ['read', 'write', 'manage', 'moderate'] },
      { subject: 'chat.integration', actions: ['invoke'] },
    ),
  },
];

export const MODULE_REGISTRY: Record<string, ModuleDefinition> = Object.fromEntries(
  MODULES.map((m) => [m.id, m]),
);

export const ALL_MODULE_IDS = Object.keys(MODULE_REGISTRY);
export const LOCKED_MODULE_IDS = MODULES.filter((m) => m.locked).map((m) => m.id);

export function validateModuleIds(ids: string[]): string[] {
  return ids.filter((id) => id in MODULE_REGISTRY);
}

export function ensureLockedModules(ids: string[]): string[] {
  const set = new Set(validateModuleIds(ids));
  for (const locked of LOCKED_MODULE_IDS) set.add(locked);
  return Array.from(set);
}

export function resolveDependencies(ids: string[]): string[] {
  const validIds = validateModuleIds(ids);
  const resolved = new Set<string>(ensureLockedModules(validIds));
  let changed = true;
  while (changed) {
    changed = false;
    for (const moduleId of Array.from(resolved)) {
      const def = MODULE_REGISTRY[moduleId];
      if (!def) continue;
      for (const dep of def.dependencies) {
        if (!resolved.has(dep)) {
          resolved.add(dep);
          changed = true;
        }
      }
    }
  }
  return Array.from(resolved);
}

/**
 * FR-PSET-050: modules that `resolveDependencies` would additionally enable when
 * turning on `moduleId` in a project that currently has `currentlyEnabled`.
 */
export function previewEnableCascade(moduleId: string, currentlyEnabled: string[]): string[] {
  if (!(moduleId in MODULE_REGISTRY)) return [];
  const before = new Set(resolveDependencies(currentlyEnabled));
  const after = resolveDependencies([...currentlyEnabled, moduleId]);
  return after.filter((id) => !before.has(id) && id !== moduleId).sort();
}

export function normalizeModuleConfigs(
  enabledModuleIds: string[] | undefined,
  rawConfigs: unknown,
): ProjectModuleConfig[] {
  const byId = new Map<string, ProjectModuleConfig>();
  const validEnabled = resolveDependencies(enabledModuleIds ?? []);
  for (const id of validEnabled) {
    byId.set(id, {
      moduleId: id,
      enabled: true,
      installed: true,
      personalSettings: {},
      integrationSettings: {},
      integrationMethodsEnabled: [],
    });
  }

  if (Array.isArray(rawConfigs)) {
    for (const item of rawConfigs) {
      if (!item || typeof item !== 'object') continue;
      const rec = item as Record<string, unknown>;
      const moduleId = typeof rec.moduleId === 'string' ? rec.moduleId : '';
      if (!(moduleId in MODULE_REGISTRY)) continue;
      const prev = byId.get(moduleId);
      const def = MODULE_REGISTRY[moduleId];
      const allowedMethods = new Set(def.integrationMethods.map((m) => m.id));
      const nextEnabled = typeof rec.enabled === 'boolean' ? rec.enabled : (prev?.enabled ?? false);
      // Lifecycle (additive): preserve persisted `version`/`installed`. An enabled
      // module is implicitly installed; otherwise keep the stored install fact.
      const recVersion = typeof rec.version === 'string' ? rec.version : prev?.version;
      const recInstalled =
        typeof rec.installed === 'boolean' ? rec.installed : prev?.installed;
      const recRuntimeStatus =
        rec.runtimeStatus === 'active' || rec.runtimeStatus === 'suspended'
          ? rec.runtimeStatus
          : prev?.runtimeStatus;
      const recEverSuspended =
        typeof rec.everSuspended === 'boolean' ? rec.everSuspended : prev?.everSuspended;
      const recConfigState =
        rec.configState === 'ready' || rec.configState === 'needs_config'
          ? rec.configState
          : prev?.configState;
      byId.set(moduleId, {
        moduleId,
        ...(recVersion != null && { version: recVersion }),
        installed: recInstalled ?? nextEnabled,
        enabled: nextEnabled,
        ...(recRuntimeStatus != null && { runtimeStatus: recRuntimeStatus }),
        ...(recEverSuspended != null && { everSuspended: recEverSuspended }),
        ...(recConfigState != null && { configState: recConfigState }),
        personalSettings: sanitizeSettings(
          isRecord(rec.personalSettings) ? (rec.personalSettings as Record<string, JsonValue>) : (prev?.personalSettings ?? {}),
          def.personalSettingsSchema,
        ),
        integrationSettings: sanitizeSettings(
          isRecord(rec.integrationSettings) ? (rec.integrationSettings as Record<string, JsonValue>) : (prev?.integrationSettings ?? {}),
          def.integrationSettingsSchema,
        ),
        integrationMethodsEnabled: Array.isArray(rec.integrationMethodsEnabled)
          ? rec.integrationMethodsEnabled.filter((v): v is string => typeof v === 'string' && allowedMethods.has(v))
          : (prev?.integrationMethodsEnabled ?? []),
      });
    }
  }

  const output = Array.from(byId.values());
  const disabledIds = new Set(output.filter((c) => !c.enabled).map((c) => c.moduleId));
  for (const cfg of output) {
    if (cfg.enabled) {
      const def = MODULE_REGISTRY[cfg.moduleId];
      if (def && def.dependencies.some((dep) => disabledIds.has(dep))) {
        cfg.enabled = false;
        disabledIds.add(cfg.moduleId);
      }
    }
  }
  let cascadeChanged = true;
  while (cascadeChanged) {
    cascadeChanged = false;
    for (const cfg of output) {
      if (!cfg.enabled) continue;
      const def = MODULE_REGISTRY[cfg.moduleId];
      if (def && def.dependencies.some((dep) => disabledIds.has(dep))) {
        cfg.enabled = false;
        disabledIds.add(cfg.moduleId);
        cascadeChanged = true;
      }
    }
  }
  const mustEnable = resolveDependencies(
    output.filter((c) => c.enabled).map((c) => c.moduleId),
  );
  for (const cfg of output) {
    cfg.enabled = mustEnable.includes(cfg.moduleId);
    if (LOCKED_MODULE_IDS.includes(cfg.moduleId)) cfg.enabled = true;
    // Lifecycle invariant: an enabled (or locked) module is necessarily installed.
    if (cfg.enabled) cfg.installed = true;
  }
  return output;
}

export function extractEnabledModulesFromConfigs(configs: ProjectModuleConfig[]): string[] {
  return resolveDependencies(configs.filter((c) => c.enabled).map((c) => c.moduleId));
}

/**
 * Permission catalog (`subject:action` registry) for the whole 1st-party/system
 * module set, generated from manifests — NOT hand-written. Each legacy
 * `ModuleDefinition` is projected onto `ModuleManifestV1` via
 * `moduleDefinitionToManifest`, then `buildPermissionCatalog` unions their
 * `permissions[]` (FR-MOD-17 / R3-E1-02). This is the source consumed by
 * control / the catalog endpoint and by `validatePolicyRules` below.
 *
 * Lazily built once and memoized (the in-repo registry is static at runtime).
 */
let cachedRegistryCatalog: PermissionCatalog | null = null;
export function getRegistryPermissionCatalog(): PermissionCatalog {
  if (!cachedRegistryCatalog) {
    cachedRegistryCatalog = buildPermissionCatalog(
      MODULES.map((def) => moduleDefinitionToManifest(def)),
    );
  }
  return cachedRegistryCatalog;
}

/**
 * Build the permission catalog scoped to a set of enabled module ids
 * (FR-MOD-17: union of *effectively enabled* manifests). Dependencies are
 * resolved first so the catalog reflects what is actually reachable.
 */
export function buildProjectPermissionCatalog(enabledModuleIds: string[]): PermissionCatalog {
  const ids = new Set(resolveDependencies(enabledModuleIds));
  return buildPermissionCatalog(
    MODULES.filter((def) => ids.has(def.id)).map((def) => moduleDefinitionToManifest(def)),
  );
}

export function validatePolicyRules(
  rules: ProjectModulePolicyRule[],
): { valid: ProjectModulePolicyRule[]; rejected: ProjectModulePolicyRule[] } {
  const catalog = getRegistryPermissionCatalog();
  const valid: ProjectModulePolicyRule[] = [];
  const rejected: ProjectModulePolicyRule[] = [];
  for (const rule of rules) {
    // Module must exist AND the subject:action must be in the manifest-derived
    // catalog. The subject must belong to the rule's module namespace so a rule
    // cannot borrow another module's permission via a shared action verb.
    if (
      !(rule.moduleId in MODULE_REGISTRY) ||
      !isWithinNamespace(rule.subject, rule.moduleId) ||
      !catalog.has(rule.subject, normalizeAction(rule.action))
    ) {
      rejected.push(rule);
      continue;
    }
    valid.push(rule);
  }
  return { valid, rejected };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Merge/defaults-path sanitiser: validates `raw` against the module's shorthand
 * settings schema and returns the SOFT-cleaned value — unknown keys stripped
 * (as before) AND values that violate their declared type/enum dropped (the fix:
 * the old whitelist kept any garbage under an allowed key). Non-throwing by
 * design; `normalizeModuleConfigs` round-trips the whole project so a single bad
 * field must not blow up unrelated modules. User-facing SAVE paths that want to
 * reject invalid input should call `validateSettings` directly and surface
 * `errors` (INVALID_ARGUMENT).
 */
function sanitizeSettings(
  raw: Record<string, JsonValue>,
  schema: Record<string, JsonValue>,
): Record<string, JsonValue> {
  return validateSettings(raw, schema).value;
}

/** Owner field for an ownable data-subject (`contacts` → `ownerId`, `deals` → `assigneeId`). */
export function dataSubjectOwnerField(subject: string): string {
  for (const def of Object.values(MODULE_REGISTRY)) {
    const manifest = moduleDefinitionToManifest(def);
    for (const ds of manifest.dataSubjects ?? []) {
      if (ds.resource === subject) return ds.ownerField ?? 'ownerId';
    }
  }
  return 'ownerId';
}
