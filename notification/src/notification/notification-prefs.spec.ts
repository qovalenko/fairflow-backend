import type { Preferences } from './notification.service';
import { isQuietHoursNow, resolveDeliveryChannels } from './notification-prefs';

describe('resolveDeliveryChannels', () => {
  const basePrefs: Preferences = {
    user_id: 'u1',
    email_mode: 'immediate',
    digest_time: '',
    timezone: 'UTC',
    categories: [{ category: 'deals', in_app: true, email: false }],
    quiet_hours: null,
    updated_at: 0,
  };

  it('honors per-category email opt-out for non-critical events', () => {
    const channels = resolveDeliveryChannels(basePrefs, 'deals', 'info', ['in_app', 'email']);
    expect(channels).toEqual(['in_app']);
  });

  it('keeps matrix channels for critical severity', () => {
    const channels = resolveDeliveryChannels(basePrefs, 'deals', 'critical', ['in_app', 'email']);
    expect(channels).toEqual(['in_app', 'email']);
  });

  it('skips email when email_mode is not immediate', () => {
    const prefs = { ...basePrefs, email_mode: 'daily', categories: [] };
    const channels = resolveDeliveryChannels(prefs, 'data', 'info', ['in_app', 'email']);
    expect(channels).toEqual(['in_app']);
  });

  it('uses §7.4 defaults when category pref is absent (FR-PROFILE-270)', () => {
    const prefs = { ...basePrefs, categories: [] };
    expect(resolveDeliveryChannels(prefs, 'deals', 'info', ['in_app', 'email'])).toEqual([
      'in_app',
    ]);
    expect(resolveDeliveryChannels(prefs, 'activities', 'important', ['in_app', 'email'])).toEqual([
      'in_app',
      'email',
    ]);
  });
});

describe('isQuietHoursNow', () => {
  it('returns false when quiet hours are unset', () => {
    const prefs: Preferences = {
      user_id: 'u1',
      email_mode: 'immediate',
      digest_time: '',
      timezone: 'UTC',
      categories: [],
      quiet_hours: null,
      updated_at: 0,
    };
    expect(isQuietHoursNow(prefs)).toBe(false);
  });

  it('suppresses email inside a same-day quiet-hours window', () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-08-21T23:30:00.000Z'));
    const prefs: Preferences = {
      user_id: 'u1',
      email_mode: 'immediate',
      digest_time: '',
      timezone: 'UTC',
      categories: [{ category: 'activities', in_app: true, email: true }],
      quiet_hours: { from: '22:00', to: '08:00', tz: 'UTC' },
      updated_at: 0,
    };
    expect(isQuietHoursNow(prefs)).toBe(true);
    expect(resolveDeliveryChannels(prefs, 'activities', 'info', ['in_app', 'email'])).toEqual([
      'in_app',
    ]);
    jest.useRealTimers();
  });

  it('returns false for invalid timezone instead of throwing', () => {
    const prefs: Preferences = {
      user_id: 'u1',
      email_mode: 'immediate',
      digest_time: '',
      timezone: 'UTC',
      categories: [],
      quiet_hours: { from: '22:00', to: '08:00', tz: 'Not/A_Timezone' },
      updated_at: 0,
    };
    expect(isQuietHoursNow(prefs)).toBe(false);
  });
});
