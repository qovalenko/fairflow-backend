import {
  NOTIFICATION_RETENTION_DAYS,
  NOTIFICATION_RETENTION_MS,
  notificationExpiresAt,
  notificationRetentionTtlSeconds,
} from './notification-retention';

describe('notification-retention', () => {
  it('defaults to 90 days', () => {
    expect(NOTIFICATION_RETENTION_DAYS).toBe(90);
    expect(NOTIFICATION_RETENTION_MS).toBe(90 * 24 * 60 * 60 * 1_000);
    expect(notificationRetentionTtlSeconds()).toBe(0);
  });

  it('computes expires_at from created_at ms', () => {
    const from = Date.UTC(2026, 0, 1);
    expect(notificationExpiresAt(from).getTime()).toBe(from + NOTIFICATION_RETENTION_MS);
  });
});
