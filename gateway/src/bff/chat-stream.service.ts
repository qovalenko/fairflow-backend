import { Injectable, Logger } from '@nestjs/common';
import { RedisPubSubService } from './redis-pubsub.service';

/**
 * Chat realtime fanout seam (M-CHAT-5/6, contracts/chat.md §3.20/§5.3/§7).
 *
 * The chat domain is gRPC-only and never holds a socket; realtime is terminated
 * on the gateway and fanned out via Redis Pub/Sub so a frame produced on replica
 * A reaches a WS/SSE connection on replica B (NFR-CHAT-6, OQ-CHAT-16 — no sticky
 * sessions). After a successful `SendMessage` the BFF publishes the `message`
 * frame to `chat:conv:{id}`; `MarkRead`/`MarkAllRead` publish a `badge` frame to
 * `chat:badge:{userId}`. WS clients additionally publish `typing` frames to
 * `chat:conv:{id}` and refresh their presence/open-state TTL keys.
 *
 * Channel scheme (contracts §5.3):
 *  - `chat:conv:{conversationId}`     — message / typing / read / presence frames
 *  - `chat:badge:{userId}`            — aggregate unread badge
 *  - `chat:presence:{userId}`         — TTL 30s, "online" heartbeat
 *  - `chat:lastseen:{userId}`         — last activity epoch ms (FR-CHAT-250)
 *  - `chat:open:{userId}:{convId}`    — TTL, notification suppression (FR-CHAT-33)
 *
 * Membership filtering for `chat:conv:{id}` (SEC-C-1/4) is the SUBSCRIBER's
 * responsibility: a connection only subscribes to conversations the user is an
 * active member of, and the WS/SSE handler re-validates membership periodically.
 */

export type ChatFrame =
  | { type: 'message'; conversationId: string; message: Record<string, unknown> }
  | { type: 'badge'; projectId?: string; userId?: string; unread?: number }
  | { type: 'presence'; conversationId: string; userId: string; state: 'online' | 'offline' }
  | { type: 'typing'; conversationId: string; userId: string }
  | { type: 'read'; conversationId: string; userId: string; lastReadSeq: number };

const PRESENCE_TTL_S = Number.parseInt(process.env.CHAT_PRESENCE_TTL_S ?? '30', 10);
const OPEN_STATE_TTL_S = Number.parseInt(process.env.CHAT_OPEN_STATE_TTL_S ?? '120', 10);

@Injectable()
export class ChatStreamService {
  private readonly logger = new Logger(ChatStreamService.name);

  constructor(private readonly redis: RedisPubSubService) {}

  static convChannel(conversationId: string): string {
    return `chat:conv:${conversationId}`;
  }
  static badgeChannel(userId: string): string {
    return `chat:badge:${userId}`;
  }
  private static presenceKey(userId: string): string {
    return `chat:presence:${userId}`;
  }
  private static lastSeenKey(userId: string): string {
    return `chat:lastseen:${userId}`;
  }
  private static openKey(userId: string, conversationId: string): string {
    return `chat:open:${userId}:${conversationId}`;
  }

  /** Fan a frame out to every subscriber of a conversation (members only). */
  publishToConversation(conversationId: string, frame: ChatFrame): void {
    if (!conversationId) return;
    this.redis.publish(ChatStreamService.convChannel(conversationId), frame);
  }

  /** Push an aggregate unread badge to a user (cross-tab/replica sync). */
  publishBadge(userId: string, frame: ChatFrame): void {
    if (!userId) return;
    this.redis.publish(ChatStreamService.badgeChannel(userId), frame);
  }

  /** Subscribe a connection to a conversation channel. Returns unsubscribe. */
  subscribeConversation(conversationId: string, onFrame: (frame: ChatFrame) => void): () => void {
    return this.redis.subscribe(ChatStreamService.convChannel(conversationId), (msg) =>
      this.deliver(msg, onFrame),
    );
  }

  /** Subscribe a connection to a user's badge channel. Returns unsubscribe. */
  subscribeBadge(userId: string, onFrame: (frame: ChatFrame) => void): () => void {
    return this.redis.subscribe(ChatStreamService.badgeChannel(userId), (msg) =>
      this.deliver(msg, onFrame),
    );
  }

  private deliver(message: string, onFrame: (frame: ChatFrame) => void): void {
    try {
      onFrame(JSON.parse(message) as ChatFrame);
    } catch {
      // Drop malformed cross-replica frames.
    }
  }

  /** Refresh presence TTL + last-seen timestamp (WS heartbeat / SSE connect). */
  async heartbeatPresence(userId: string): Promise<void> {
    if (!userId) return;
    const now = String(Date.now());
    await this.redis.setEx(ChatStreamService.presenceKey(userId), '1', PRESENCE_TTL_S);
    await this.redis.setPersist(ChatStreamService.lastSeenKey(userId), now);
  }

  /** Snapshot online + last-seen for users (presence endpoint, FR-CHAT-250). */
  async readPresence(
    userIds: string[],
  ): Promise<{ userId: string; online: boolean; lastSeenAt?: number }[]> {
    const out: { userId: string; online: boolean; lastSeenAt?: number }[] = [];
    for (const userId of userIds) {
      const v = await this.redis.get(ChatStreamService.presenceKey(userId));
      const online = v !== null;
      let lastSeenAt: number | undefined;
      if (!online) {
        const ls = await this.redis.get(ChatStreamService.lastSeenKey(userId));
        if (ls != null) {
          const n = Number(ls);
          if (Number.isFinite(n) && n > 0) lastSeenAt = n;
        }
      }
      out.push({ userId, online, ...(lastSeenAt != null ? { lastSeenAt } : {}) });
    }
    return out;
  }

  /** Mark a conversation as open for a user (suppresses notifications, FR-CHAT-33). */
  async setOpenState(userId: string, conversationId: string, open: boolean): Promise<void> {
    if (!userId || !conversationId) return;
    const key = ChatStreamService.openKey(userId, conversationId);
    if (open) await this.redis.setEx(key, '1', OPEN_STATE_TTL_S);
    else await this.redis.del(key);
  }

  get redisEnabled(): boolean {
    return this.redis.redisEnabled;
  }
}
