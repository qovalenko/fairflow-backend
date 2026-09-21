import { Logger } from '@nestjs/common';
import type { FastifyInstance, FastifyRequest } from 'fastify';
// named import: default-импорт CJS-модуля (`import jwt from`) в части транспиляций
// (dev/SWC без esModuleInterop) даёт undefined → jwt.verify падал → WS закрывался 4401.
import { verify as jwtVerify } from 'jsonwebtoken';
import { ChatStreamService, type ChatFrame } from './chat-stream.service';
import type { ChatRealtimeAccessService, ChatRealtimeActor } from './chat-realtime-access.service';
import { assertChatTypingAllowed, chatWsConnectionRegistry } from './chat-rate-limit';

/**
 * WS terminator for chat realtime (contracts/chat.md §3.20/§7, M-CHAT-5).
 *
 * Registered on the RAW Fastify instance (not a Nest route) because the gateway
 * runs on Fastify and `/ws/chat` is an HTTP→WS upgrade, not REST. The global Nest
 * JWT guard does not run on a raw route, so the whole authentication/authorization
 * chain is enforced HERE (SEC-C-4), through ChatRealtimeAccessService:
 *  - signature/exp at upgrade — an invalid token closes the socket before any frame;
 *  - the jti deny-list, so a revoked session (logout/offboarding) cannot open or
 *    keep a socket until the token's natural `exp`;
 *  - active membership for every conversation channel, re-checked periodically.
 *
 * Direction:
 *  - server→client: `message` / `badge` / `presence` / `typing` / `read` frames,
 *    fanned out from Redis (`chat:conv:{id}`, `chat:badge:{userId}`).
 *  - client→server: `typing` (republished to chat:conv:{id}), `heartbeat`
 *    (refreshes presence TTL), `open`/`close` (open-state for notif suppression),
 *    `subscribe`/`unsubscribe` (join a conversation channel — the requested id is
 *    authorized against the member-only set from the chat domain, never trusted).
 *
 * Multi-replica is transparent: every replica subscribes to Redis, so a frame
 * published by replica A reaches a socket held on replica B (OQ-CHAT-16).
 */

type WsSocket = {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  // ws-protocol level ping/pong keepalive (present on the underlying `ws` socket).
  ping?(data?: unknown, mask?: boolean, cb?: (err?: Error) => void): void;
  readyState?: number;
  on(event: 'message', cb: (data: unknown) => void): void;
  on(event: 'close', cb: () => void): void;
  on(event: 'error', cb: (err: Error) => void): void;
  on(event: 'pong', cb: () => void): void;
};

// ws.OPEN === 1 (avoid importing the `ws` types just for the constant).
const WS_OPEN = 1;

const logger = new Logger('ChatWsGateway');

export function bearerFromRequest(req: FastifyRequest): string | null {
  const auth = req.headers['authorization'];
  if (typeof auth === 'string' && auth.startsWith('Bearer ')) return auth.slice(7);
  // TODO-285: JWT in query string is rejected — tokens must not appear in access logs.
  // Cookie fallback remains for same-site WS upgrades; primary path is the first
  // post-connect `{type:'auth', token}` frame from the client.
  const cookie = req.headers['cookie'];
  if (typeof cookie === 'string') {
    for (const p of cookie.split(';').map((x) => x.trim())) {
      if (p.startsWith('ff_access_token='))
        return decodeURIComponent(p.slice('ff_access_token='.length));
      if (p.startsWith('token=')) return decodeURIComponent(p.slice('token='.length));
    }
  }
  return null;
}

function verifyToken(token: string, jwtSecret: string): { sub?: string; jti?: string } | null {
  const secret = process.env.JWT_SECRET || jwtSecret;
  try {
    return jwtVerify(token, secret) as { sub?: string; jti?: string };
  } catch {
    return null;
  }
}

/**
 * Register `GET /ws/chat`. Resolves ChatStreamService from the Nest container so
 * the same Redis fanout backs WS, SSE and the REST publish path.
 */
export function registerChatWebsocket(
  fastify: FastifyInstance,
  stream: ChatStreamService,
  jwtSecret: string,
  access: ChatRealtimeAccessService,
  onWsConnectionsChange?: (total: number) => void,
): void {
  if (onWsConnectionsChange) {
    chatWsConnectionRegistry.bindGauge(onWsConnectionsChange);
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const f = fastify as any;
  if (typeof f.get !== 'function') return;

  f.get('/ws/chat', { websocket: true }, (socket: WsSocket, req: FastifyRequest) => {
    const upgradeToken = bearerFromRequest(req);
    const AUTH_WAIT_MS = Number.parseInt(process.env.GATEWAY_WS_AUTH_WAIT_MS ?? '10000', 10);
    let authenticated = false;
    let userId = '';
    let sessionId = '';

    const projectId =
      (req.query as Record<string, unknown> | undefined)?.['projectId'] != null
        ? String((req.query as Record<string, unknown>)['projectId'])
        : undefined;

    const unsubscribers: (() => void)[] = [];
    const convUnsubs = new Map<string, () => void>();
    let cleaned = false;
    let authTimer: ReturnType<typeof setTimeout> | null = null;
    let actor: ChatRealtimeActor = {
      userId: '',
      sessionId: '',
      headers: req.headers as Record<string, unknown>,
      projectId,
    };
    let send: (frame: ChatFrame) => void = () => undefined;
    let denyRevoked: () => Promise<boolean> = async () => false;
    let refreshAllowed: () => Promise<void> = async () => undefined;
    let subscribeConversation: (conversationId: string) => Promise<void> = async () => undefined;
    let revalidate: () => Promise<void> = async () => undefined;
    let ping: ReturnType<typeof setInterval> | null = null;

    const cleanup = () => {
      if (cleaned) return;
      cleaned = true;
      if (authTimer) clearTimeout(authTimer);
      if (ping) clearInterval(ping);
      if (userId) chatWsConnectionRegistry.release(userId);
      for (const u of unsubscribers) u();
      for (const u of convUnsubs.values()) u();
      convUnsubs.clear();
    };

    const failAuth = (reason: string) => {
      cleanup();
      socket.close(4401, reason.slice(0, 110));
    };

    const activate = (token: string): boolean => {
      const claims = verifyToken(token, jwtSecret);
      if (!claims) {
        failAuth('verify:invalid-token');
        return false;
      }
      userId = String(claims?.sub ?? '');
      sessionId = String(claims?.jti ?? '');
      if (!userId) {
        failAuth('no-sub');
        return false;
      }
      if (!chatWsConnectionRegistry.tryAcquire(userId)) {
        failAuth('conn-limit');
        return false;
      }
      authenticated = true;
      if (authTimer) {
        clearTimeout(authTimer);
        authTimer = null;
      }
      actor = { userId, sessionId, headers: req.headers as Record<string, unknown>, projectId };
      send = (frame: ChatFrame) => {
        try {
          socket.send(JSON.stringify(frame));
        } catch {
          /* socket closing */
        }
      };
      send({ type: 'badge', userId } as ChatFrame);
      try {
        unsubscribers.push(stream.subscribeBadge(userId, send));
        void stream.heartbeatPresence(userId);
      } catch (e) {
        logger.warn(`chat WS subscribe failed (degraded, socket kept): ${(e as Error).message}`);
      }
      return true;
    };

    if (upgradeToken) {
      if (!activate(upgradeToken)) return;
    } else {
      authTimer = setTimeout(() => failAuth('auth-timeout'), AUTH_WAIT_MS);
    }

    // Revocation PEP + membership refresh — wired after activate().
    const wireSessionGuards = () => {
      denyRevoked = async (): Promise<boolean> => {
        const active = await access.isSessionActive(actor).catch(() => false);
        if (active) return false;
        cleanup();
        socket.close(4401, 'session-revoked');
        return true;
      };
      void denyRevoked();

      const REVALIDATE_MS = Number.parseInt(process.env.GATEWAY_WS_REVALIDATE_MS ?? '60000', 10);
      let allowed = new Set<string>();
      let allowedAt = 0;
      let refreshing: Promise<void> | null = null;
      refreshAllowed = (): Promise<void> => {
        if (!refreshing) {
          refreshing = access
            .memberConversationIds(actor)
            .then((ids) => {
              allowed = ids;
              allowedAt = Date.now();
            })
            .catch(() => undefined)
            .finally(() => {
              refreshing = null;
            });
        }
        return refreshing;
      };

      subscribeConversation = async (conversationId: string) => {
        if (!conversationId || convUnsubs.has(conversationId)) return;
        if (!allowed.has(conversationId) && Date.now() - allowedAt >= REVALIDATE_MS) {
          await refreshAllowed();
        }
        if (!allowed.has(conversationId) || convUnsubs.has(conversationId)) return;
        try {
          convUnsubs.set(conversationId, stream.subscribeConversation(conversationId, send));
        } catch (e) {
          logger.warn(`chat WS subscribe failed (degraded, socket kept): ${(e as Error).message}`);
        }
      };

      revalidate = async () => {
        if (await denyRevoked()) return;
        await refreshAllowed();
        for (const [conversationId, unsubscribe] of convUnsubs) {
          if (!allowed.has(conversationId)) {
            unsubscribe();
            convUnsubs.delete(conversationId);
          }
        }
      };

      const revalidateTimer = setInterval(() => {
        void revalidate();
      }, REVALIDATE_MS);
      unsubscribers.push(() => clearInterval(revalidateTimer));
    };

    if (authenticated) {
      wireSessionGuards();
    }

    socket.on('message', (raw) => {
      // Any inbound frame proves the peer is alive (the FE sends `heartbeat` on an
      // interval), so it also satisfies the ping/pong liveness check above.
      alive = true;
      let frame: Record<string, unknown>;
      try {
        frame = JSON.parse(String(raw)) as Record<string, unknown>;
      } catch {
        return;
      }
      const type = String(frame.type ?? '');
      if (!authenticated) {
        if (type !== 'auth') return;
        const token = typeof frame.token === 'string' ? frame.token : '';
        if (!token) {
          failAuth('no-token');
          return;
        }
        if (!activate(token)) return;
        wireSessionGuards();
        return;
      }
      const conversationId = frame.conversationId ? String(frame.conversationId) : '';
      switch (type) {
        case 'subscribe':
          void subscribeConversation(conversationId);
          break;
        case 'typing':
          // Only a member can publish into a conversation — and only a member could
          // have been subscribed to it above. Throttle ≤1/s (NFR-CHAT-090).
          if (convUnsubs.has(conversationId)) {
            try {
              assertChatTypingAllowed(userId, conversationId);
            } catch {
              break;
            }
            stream.publishToConversation(conversationId, {
              type: 'typing',
              conversationId,
              userId,
            });
          }
          break;
        case 'heartbeat':
          void stream.heartbeatPresence(userId);
          break;
        case 'open':
          void stream.setOpenState(userId, conversationId, true);
          break;
        case 'close':
          void stream.setOpenState(userId, conversationId, false);
          break;
        default:
          break;
      }
    });

    // Mark the socket alive on every protocol pong (and on any client frame, see
    // the message handler) so we only ever terminate genuinely dead connections.
    let alive = true;
    socket.on('pong', () => {
      alive = true;
    });

    // Keep presence warm + KEEP THE SOCKET ALIVE THROUGH IDLE PROXIES (SEC-C-4).
    // ingress-nginx/idle proxies cut a WS with no traffic after ~60s, which the FE
    // saw as "connection lost → reconnect" looping. A periodic ws-protocol ping
    // (PING_MS < the proxy idle timeout) generates traffic both ways; if a peer
    // misses a full interval we terminate so the FE reconnects on a fresh socket
    // instead of holding a half-open one.
    const PING_MS = Number.parseInt(process.env.GATEWAY_WS_PING_MS ?? '25000', 10);
    const MAX_TTL_MS = Number.parseInt(process.env.GATEWAY_WS_MAX_TTL_MS ?? '900000', 10);
    const startedAt = Date.now();
    ping = setInterval(() => {
      void stream.heartbeatPresence(userId);
      // Liveness: a socket that missed the previous ping/pong round-trip is dead.
      if (!alive) {
        cleanup();
        socket.close(4408, 'ping-timeout');
        return;
      }
      if (Date.now() - startedAt >= MAX_TTL_MS) {
        cleanup();
        socket.close(4408, 'ttl');
        return;
      }
      alive = false;
      if (typeof socket.ping === 'function' && socket.readyState === WS_OPEN) {
        try {
          socket.ping();
        } catch {
          /* socket closing — cleanup runs on close */
        }
      } else {
        // No protocol ping available → fall back to an app-level keepalive frame
        // the FE tolerates (unknown-type frames are ignored client-side).
        send({ type: 'badge', userId } as ChatFrame);
        alive = true; // can't observe a pong without ws.ping; assume alive.
      }
    }, PING_MS);

    socket.on('close', cleanup);
    socket.on('error', cleanup);
  });

  logger.log('Registered WS /ws/chat (Redis-backed realtime fanout).');
}
