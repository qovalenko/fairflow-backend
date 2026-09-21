/** FR-NOTIF-070 / NFR-MNOT-7: notification feed retention window (days). */
export const NOTIFICATION_RETENTION_DAYS = Math.max(
  1,
  Number(process.env.NOTIFICATION_RETENTION_DAYS ?? 90) || 90,
);

export const NOTIFICATION_RETENTION_MS = NOTIFICATION_RETENTION_DAYS * 24 * 60 * 60 * 1_000;

/** BSON Date when a notification row becomes eligible for TTL purge. */
export function notificationExpiresAt(fromMs: number = Date.now()): Date {
  return new Date(fromMs + NOTIFICATION_RETENTION_MS);
}

/** TTL index window in seconds (Mongo `expireAfterSeconds: 0` deletes at `expires_at`). */
export function notificationRetentionTtlSeconds(): number {
  return 0;
}
