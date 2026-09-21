import type { NotifyI18nTemplate } from './module-manifest';

const DEFAULT_LOCALE = 'ru';

/** Replace `{{key}}` placeholders in a template string. Unknown keys → empty. */
export function renderNotifyTemplate(
  template: string,
  vars: Record<string, string>,
): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_, key: string) => vars[key] ?? '');
}

/** Pick the best locale from an i18n map (ru → en → first available). */
export function pickNotifyLocale(
  map: Record<string, string>,
  preferred: string = DEFAULT_LOCALE,
): string {
  if (map[preferred]) return map[preferred];
  if (map.en) return map.en;
  const first = Object.values(map)[0];
  return first ?? '';
}

/** Render title/body from manifest i18n templates. */
export function renderNotifyI18n(
  i18n: NotifyI18nTemplate,
  vars: Record<string, string>,
  locale: string = DEFAULT_LOCALE,
): { title: string; body: string } {
  return {
    title: renderNotifyTemplate(pickNotifyLocale(i18n.title, locale), vars),
    body: renderNotifyTemplate(pickNotifyLocale(i18n.body, locale), vars),
  };
}
