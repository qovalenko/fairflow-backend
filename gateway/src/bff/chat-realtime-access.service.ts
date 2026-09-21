import { Inject, Injectable, OnModuleInit, Optional } from '@nestjs/common';
import { ClientGrpcProxy } from '@nestjs/microservices';
import { grpcBffCall } from './grpc-bff-call';
import { GatewayOutboundMetadataService } from './gateway-outbound-metadata.service';
import { SystemOrgResolverService } from './system-org-resolver.service';
import { SessionDenyListService } from '../auth/session-deny-list.service';

/** Actor behind a realtime connection, resolved from the JWT at the WS upgrade. */
export type ChatRealtimeActor = {
  userId: string;
  /** jti — the session the token belongs to (deny-list key). */
  sessionId: string;
  headers: Record<string, unknown>;
  /** Project passed on the upgrade URL; scopes the channel (project) candidate. */
  projectId?: string;
};

/**
 * Access PEP for the raw-Fastify chat realtime terminator (SEC-C-4).
 *
 * `/ws/chat` is registered outside the Nest router, so the guards that protect the
 * REST/SSE surface (JwtAuthGuard + jti deny-list, membership via the domain) never
 * run on it. This service is the explicit replacement: it answers the only two
 * questions the socket needs — is the session still active, and which conversations
 * is the actor an ACTIVE member of — using the same gRPC path and outbound metadata
 * as the BFF controllers, so the domain stays the single source of truth.
 */
@Injectable()
export class ChatRealtimeAccessService implements OnModuleInit {
  private chat!: Record<string, (x: unknown, m?: unknown) => unknown>;

  constructor(
    @Inject('CHAT_GRPC') private readonly chatClient: ClientGrpcProxy,
    private readonly outboundMeta: GatewayOutboundMetadataService,
    private readonly systemOrg: SystemOrgResolverService,
    @Optional() private readonly denyList?: SessionDenyListService,
  ) {}

  onModuleInit() {
    this.chat = this.chatClient.getService('ChatService');
  }

  /** False when the token's session was revoked (logout / offboarding). */
  async isSessionActive(actor: ChatRealtimeActor): Promise<boolean> {
    if (!this.denyList) return true;
    return this.denyList.isAllowed(actor.userId, actor.sessionId, actor.headers);
  }

  /**
   * Ids of the conversations the actor may receive frames from. `ListConversations`
   * already filters by active membership (`members{userId, leftAt:null}`), so the
   * returned set IS the membership answer.
   *
   * A socket carries no guard-resolved context, so the isolation scopes are built
   * here from what it does have: the project of the upgrade URL (channels) and the
   * box org anchor (DM/group) — the domain resolves exactly one scope per call, so
   * both are queried and merged. Archived conversations are included: archiving
   * hides a conversation from the list, it does not end the membership.
   *
   * Throws when every scope query failed (chat unreachable) so the caller can keep
   * its previous answer instead of reading an infra fault as "member of nothing".
   */
  async memberConversationIds(actor: ChatRealtimeActor): Promise<Set<string>> {
    const organizationId = await this.systemOrg.resolveSystemOrgId({
      headers: actor.headers,
      user: { userId: actor.userId },
    });
    const scopes: ({ projectId: string } | undefined)[] = [];
    if (actor.projectId) scopes.push({ projectId: actor.projectId });
    if (organizationId) scopes.push(undefined);

    const ids = new Set<string>();
    let failed = 0;
    for (const scope of scopes) {
      try {
        const md = this.outboundMeta.build(
          {
            headers: actor.headers,
            user: { userId: actor.userId, sessionId: actor.sessionId },
            __systemOrgId: organizationId,
          } as never,
          scope,
        );
        const r = (await grpcBffCall(
          this.chat.listConversations(
            { include_archived: true, scope_filter: 'current' },
            md,
          ) as never,
        )) as { conversations?: Record<string, unknown>[] };
        for (const c of r.conversations ?? []) {
          const id = String(c.id ?? '');
          if (id) ids.add(id);
        }
      } catch {
        failed += 1;
      }
    }
    if (scopes.length > 0 && failed === scopes.length) {
      throw new Error('chat ListConversations unavailable');
    }
    return ids;
  }
}
