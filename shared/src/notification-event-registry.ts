import type { ManifestNotifyEvent, NotifyFanoutGroup } from './module-manifest';
import { MODULE_MANIFESTS } from './module-manifests';

export type NotificationEventSpec = ManifestNotifyEvent & {
  moduleId: string;
};

/** Platform/control events not owned by a removable business module manifest. */
const SUPPLEMENTAL_NOTIFICATION_EVENTS: NotificationEventSpec[] = [
  {
    eventType: 'control.record.shared',
    moduleId: 'documents',
    category: 'data',
    severity: 'info',
    defaultChannels: ['in_app'],
    addressee: 'subscriber',
    i18n: {
      title: { ru: 'Вам предоставлен доступ', en: 'Access granted' },
      body: {
        ru: 'С вами поделились записью {{entityType}} {{entityId}}',
        en: 'A {{entityType}} record {{entityId}} was shared with you',
      },
    },
  },
  {
    eventType: 'control.visibility.narrowed',
    moduleId: 'documents',
    category: 'access',
    severity: 'important',
    defaultChannels: ['in_app'],
    i18n: {
      title: { ru: 'Ваш охват записей сужен', en: 'Your record visibility narrowed' },
      body: {
        ru: 'Видимость роли {{role}} снижена: {{from}} → {{to}}',
        en: 'Role {{role}} visibility narrowed: {{from}} → {{to}}',
      },
    },
  },
  {
    eventType: 'control.role.assignment.expiring',
    moduleId: 'documents',
    category: 'access',
    severity: 'important',
    defaultChannels: ['in_app'],
    i18n: {
      title: { ru: 'Срок назначения роли истекает', en: 'Role assignment expiring' },
      body: {
        ru: 'Назначение роли истекает {{expiresAt}}',
        en: 'Role assignment expires {{expiresAt}}',
      },
    },
  },
  {
    eventType: 'control.role.changed',
    moduleId: 'documents',
    category: 'access',
    severity: 'important',
    defaultChannels: ['in_app'],
    i18n: {
      title: { ru: 'Права роли изменены', en: 'Role permissions changed' },
      body: {
        ru: 'Обновлены права роли — проверьте свой доступ в проекте',
        en: 'Role permissions were updated — review your project access',
      },
    },
  },
  {
    eventType: 'control.role.assigned',
    moduleId: 'notifications',
    category: 'access',
    severity: 'important',
    defaultChannels: ['in_app', 'email'],
    i18n: {
      title: { ru: 'Изменился ваш доступ к проекту', en: 'Your project access changed' },
      body: {
        ru: 'Вам назначена роль «{{role}}» в проекте',
        en: 'You were assigned role «{{role}}» in the project',
      },
    },
  },
  {
    eventType: 'control.role.revoked',
    moduleId: 'notifications',
    category: 'access',
    severity: 'important',
    defaultChannels: ['in_app', 'email'],
    i18n: {
      title: { ru: 'Доступ к проекту закрыт', en: 'Project access revoked' },
      body: {
        ru: 'Вас исключили из проекта или отозвали доступ',
        en: 'You were removed from the project or your access was revoked',
      },
    },
  },
  {
    eventType: 'billing.quota.exceeded',
    moduleId: 'billing',
    category: 'billing',
    severity: 'critical',
    defaultChannels: ['in_app', 'email'],
    fanout: ['pa'],
    i18n: {
      title: { ru: 'Превышена квота', en: 'Quota exceeded' },
      body: {
        ru: 'Превышен лимит «{{metric}}» в проекте',
        en: 'Quota «{{metric}}» exceeded in project',
      },
    },
  },
  {
    eventType: 'billing.grace.expiring',
    moduleId: 'billing',
    category: 'billing',
    severity: 'critical',
    defaultChannels: ['in_app', 'email'],
    fanout: ['pa'],
    i18n: {
      title: { ru: 'Истекает льготный период', en: 'Grace period expiring' },
      body: {
        ru: 'Льготный период подписки скоро завершится',
        en: 'Subscription grace period is ending soon',
      },
    },
  },
  {
    eventType: 'crm.activity.reassigned',
    moduleId: 'activities',
    category: 'activities',
    severity: 'info',
    defaultChannels: ['in_app'],
    i18n: {
      title: { ru: 'Вам назначена активность', en: 'Activity assigned to you' },
      body: { ru: 'Назначена активность', en: 'Activity assigned' },
    },
  },
  {
    eventType: 'crm.activity.overdue',
    moduleId: 'activities',
    category: 'activities',
    severity: 'info',
    defaultChannels: ['in_app'],
    fanout: ['leader'],
    i18n: {
      title: { ru: 'Просроченная активность', en: 'Overdue activity' },
      body: { ru: 'Просрочена активность', en: 'Activity overdue' },
    },
  },
  {
    eventType: 'automation.action.failed',
    moduleId: 'automation',
    category: 'data',
    severity: 'important',
    defaultChannels: ['in_app'],
    fanout: ['pa'],
    i18n: {
      title: { ru: 'Ошибка автоматизации', en: 'Automation action failed' },
      body: {
        ru: 'Действие правила не выполнено ({{entityLabel}})',
        en: 'Rule action failed ({{entityLabel}})',
      },
    },
  },
  {
    eventType: 'automation.dlq.exhausted',
    moduleId: 'automation',
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
  {
    eventType: 'crm.activity.reminder',
    moduleId: 'activities',
    category: 'activities',
    severity: 'important',
    defaultChannels: ['in_app', 'email'],
    i18n: {
      title: { ru: 'Напоминание об активности', en: 'Activity reminder' },
      body: { ru: 'Напоминание об активности', en: 'Activity reminder' },
    },
  },
];

const REGISTRY = new Map<string, NotificationEventSpec>();

for (const manifest of Object.values(MODULE_MANIFESTS)) {
  for (const evt of manifest.notify?.events ?? []) {
    REGISTRY.set(evt.eventType, { ...evt, moduleId: manifest.id });
  }
}
for (const evt of SUPPLEMENTAL_NOTIFICATION_EVENTS) {
  if (!REGISTRY.has(evt.eventType)) REGISTRY.set(evt.eventType, evt);
}

/** Lookup notification projection for a routing key (FR-NOTIF-210). */
export function getNotificationEventSpec(eventType: string): NotificationEventSpec | undefined {
  return REGISTRY.get(eventType);
}

/** All registered event types (consumer binding). */
export function listNotificationEventTypes(): string[] {
  return Array.from(REGISTRY.keys());
}

/** Module id that owns a routing key (FR-NOTIF-240). */
export function notificationEventModuleId(eventType: string): string | undefined {
  return REGISTRY.get(eventType)?.moduleId;
}

export type { NotifyFanoutGroup };
