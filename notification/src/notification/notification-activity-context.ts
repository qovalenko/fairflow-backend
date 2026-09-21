import type { EventEnvelope } from '@fairflow/shared';
import { pickNotifyLocale } from '@fairflow/shared';

function str(v: unknown): string {
  return typeof v === 'string' ? v : v == null ? '' : String(v);
}

const ACTIVITY_I18N = {
  typeLabels: {
    task: { ru: 'Задача', en: 'Task' },
    call: { ru: 'Звонок', en: 'Call' },
    meeting: { ru: 'Встреча', en: 'Meeting' },
    note: { ru: 'Заметка', en: 'Note' },
  },
  linksPrefix: { ru: 'Привязка:', en: 'Links:' },
  duePrefix: { ru: 'Срок:', en: 'Due:' },
  fallbackType: { ru: 'Активность', en: 'Activity' },
} as const;

export function activityTypeLabel(type: unknown, locale = 'ru'): string {
  const key = str(type).trim();
  const labels = ACTIVITY_I18N.typeLabels[key as keyof typeof ACTIVITY_I18N.typeLabels];
  if (labels) return pickNotifyLocale(labels, locale);
  return key || pickNotifyLocale(ACTIVITY_I18N.fallbackType, locale);
}

export function activityTitle(payload: Record<string, unknown>): string {
  return str(payload.title).trim();
}

export function activityDueLabel(payload: Record<string, unknown>, locale = 'ru'): string {
  const raw = payload.dueDate ?? payload.due_date;
  if (raw == null || raw === '') return '';
  const ms = Number(raw);
  if (!Number.isFinite(ms) || ms <= 0) return '';
  try {
    return new Date(ms).toLocaleString(locale === 'en' ? 'en-US' : 'ru-RU', {
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return '';
  }
}

/** Human-readable summary of activity links for notification body (FR-ACTIVITIES-290). */
export function activityLinkSummary(payload: Record<string, unknown>): string {
  const links = Array.isArray(payload.links) ? payload.links : [];
  const parts = links
    .map((l) => {
      if (!l || typeof l !== 'object') return '';
      const row = l as Record<string, unknown>;
      const snap = str(row.nameSnapshot ?? row.name_snapshot).trim();
      const type = str(row.entityType ?? row.entity_type).trim();
      if (snap) return snap;
      if (type) return type;
      return '';
    })
    .filter(Boolean);
  return parts.length ? parts.join(', ') : '';
}

export function activityNotificationBody(
  env: EventEnvelope<Record<string, unknown>>,
  action: string,
  locale = 'ru',
): string {
  const p = (env.payload ?? {}) as Record<string, unknown>;
  const title = activityTitle(p);
  const type = activityTypeLabel(p.type, locale);
  const links = activityLinkSummary(p);
  const due = activityDueLabel(p, locale);
  const chunks = [action];
  if (title) chunks.push(`«${title}»`);
  chunks.push(`(${type})`);
  if (links) {
    chunks.push(`${pickNotifyLocale(ACTIVITY_I18N.linksPrefix, locale)} ${links}`);
  }
  if (due) {
    chunks.push(`${pickNotifyLocale(ACTIVITY_I18N.duePrefix, locale)} ${due}`);
  }
  return chunks.join(' ');
}

export function activityDeepLink(payload: Record<string, unknown>): string | undefined {
  const id = str(payload.activityId ?? payload.activity_id).trim();
  return id ? `/activities/${id}` : undefined;
}
