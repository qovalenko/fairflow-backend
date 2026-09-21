import { Injectable } from '@nestjs/common';
import { RedisPublisherService } from './redis-publisher.service';

/**
 * Real-time SSE badge signal (contract §3.5 / FR-MNOT-9, D-3) — DOMAIN publisher.
 *
 * The gateway's `NotificationStreamService` subscribes to the channel
 * `notif:user:{userId}` and pushes a `badge` SSE frame to the browser whenever a
 * user's unread state changes. This service produces exactly the frame the
 * gateway expects (`BadgeSignal`: `{ type:'badge', projectId, unread? }`) and
 * publishes it on the same channel from the domain side (materialize / markRead /
 * markAllRead). The browser uses the signal to invalidate its `count`/`list`
 * caches (≤ 3 s) instead of polling (NFR-MNOT-2).
 *
 * Fail-soft everywhere (see {@link RedisPublisherService}): a missing/unreachable
 * Redis degrades to a no-op — the feed stays authoritative in Mongo and SSE falls
 * back to client polling; a badge hint never fails the underlying mutation.
 */
export type BadgeSignal = {
  type: 'badge';
  projectId: string;
  /** Unread count when known by the publisher; omitted → the client re-fetches. */
  unread?: number;
};

@Injectable()
export class NotificationSignalService {
  constructor(private readonly redis: RedisPublisherService) {}

  /** Per-user channel key (matches gateway `notification-stream.service.ts`). */
  private channel(userId: string): string {
    return `notif:user:${userId}`;
  }

  /**
   * Publish a badge signal for one user. `unread` is optional: on materialize we
   * do not know the exact new count without an extra read, so we omit it and the
   * client re-fetches; on markAllRead we can assert `0`.
   */
  publishBadge(userId: string, projectId: string, unread?: number): void {
    if (!userId) return;
    const signal: BadgeSignal = { type: 'badge', projectId };
    if (typeof unread === 'number') signal.unread = unread;
    this.redis.publish(this.channel(userId), signal);
  }
}
