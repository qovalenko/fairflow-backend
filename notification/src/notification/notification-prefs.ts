import type { CategoryPref, Preferences } from './notification.service';
import { isMandatory } from './notification.catalog';
import { defaultCategoryPref } from './notification-defaults';

type Channel = 'in_app' | 'email';

function categoryPref(prefs: Preferences, category: string): CategoryPref | undefined {
  return prefs.categories.find((c) => c.category === category);
}

/** Whether local time (in `tz`) is inside quiet-hours window HH:mm–HH:mm. */
export function isQuietHoursNow(prefs: Preferences): boolean {
  const qh = prefs.quiet_hours;
  if (!qh?.from || !qh?.to) return false;
  const tz = (qh.tz || prefs.timezone || 'UTC').trim();
  try {
    const now = new Date();
    const fmt = new Intl.DateTimeFormat('en-GB', {
      timeZone: tz,
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    });
    const parts = fmt.formatToParts(now);
    const hour = parts.find((p) => p.type === 'hour')?.value ?? '00';
    const minute = parts.find((p) => p.type === 'minute')?.value ?? '00';
    const current = `${hour}:${minute}`;
    const from = qh.from;
    const to = qh.to;
    if (from <= to) return current >= from && current < to;
    // overnight window (e.g. 22:00–07:00)
    return current >= from || current < to;
  } catch {
    return false;
  }
}

/**
 * Intersect matrix/default channels with per-user preferences. Critical/mandatory
 * categories keep matrix channels; digest/quiet-hours defer email (TODO-405 cron
 * is out of scope — email is skipped, not queued).
 */
export function resolveDeliveryChannels(
  prefs: Preferences,
  category: string,
  severity: string,
  requested: Channel[],
): Channel[] {
  const critical = severity === 'critical' || isMandatory(category);
  if (critical) {
    return requested.length ? requested : ['in_app'];
  }

  const cat = categoryPref(prefs, category);
  const defaults = defaultCategoryPref(category);
  const wantInApp = cat ? cat.in_app : defaults.in_app;
  const wantEmail = cat ? cat.email : defaults.email;

  let channels: Channel[] = [];
  if (requested.includes('in_app') && wantInApp) channels.push('in_app');
  if (
    requested.includes('email') &&
    wantEmail &&
    prefs.email_mode === 'immediate' &&
    !isQuietHoursNow(prefs)
  ) {
    channels.push('email');
  }

  if (channels.length === 0 && wantInApp && requested.includes('in_app')) {
    channels = ['in_app'];
  }
  return channels;
}
