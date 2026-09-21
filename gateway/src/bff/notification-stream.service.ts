import { Injectable } from '@nestjs/common';
import { RedisPubSubService } from './redis-pubsub.service';

/**
 * Lightweight real-time badge signal (contract §3.5 / FR-MNOT-9, D-3).
 *
 * The SSE endpoint on the gateway holds a long-lived `text/event-stream` connection
 * per (user, project) and pushes a tiny `badge` payload whenever the user's unread
 * count changes (markRead / markAllRead / materialized notification). The browser
 * uses the signal to invalidate its SWR `count`/`list` caches (≤ 3 s) instead of
 * polling (NFR-MNOT-2).
 *
 * Transport. This service is now backed by {@link RedisPubSubService} (M-CHAT-6):
 * the formerly in-process-only seam is real cross-replica Pub/Sub when `REDIS_URL`
 * is set, and degrades to an in-process EventEmitter otherwise. A badge raised on
 * replica A therefore reaches an SSE connection held on replica B (channel
 * `notif:user:{userId}`), closing the D-3 multi-replica gap with the same surface
 * (`publishBadge` / `subscribe`) the callers already use.
 */
export type BadgeSignal = {
  type: 'badge';
  projectId: string;
  /** Unread count if known by the publisher; otherwise omitted (client re-fetches). */
  unread?: number;
};

type Listener = (signal: BadgeSignal) => void;

@Injectable()
export class NotificationStreamService {
  constructor(private readonly redis: RedisPubSubService) {}

  /** Per-user channel key. Project scoping is enforced by the SSE filter, not the key. */
  private channel(userId: string): string {
    return `notif:user:${userId}`;
  }

  /**
   * Publish a badge signal for a user. Called by the BFF mutation handlers after a
   * successful markRead / markAllRead. Now fans out across replicas via Redis.
   */
  publishBadge(userId: string, signal: BadgeSignal): void {
    if (!userId) return;
    this.redis.publish(this.channel(userId), signal);
  }

  /**
   * Subscribe an SSE connection to a user's badge signals. The returned function
   * unsubscribes (call it on connection close). The caller (SSE handler) is
   * responsible for filtering by the connection's active project (SEC-N-4): a signal
   * for a project the user is no longer a member of must not be pushed.
   */
  subscribe(userId: string, listener: Listener): () => void {
    return this.redis.subscribe(this.channel(userId), (message) => {
      try {
        listener(JSON.parse(message) as BadgeSignal);
      } catch {
        // Ignore malformed cross-replica frames.
      }
    });
  }
}
