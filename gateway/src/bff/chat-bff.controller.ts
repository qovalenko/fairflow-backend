import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Body,
  Param,
  Query,
  Inject,
  Optional,
  OnModuleInit,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import { ClientGrpcProxy } from '@nestjs/microservices';
import { grpcBffCall, toNum } from './grpc-bff-call';
import type { FastifyRequest, FastifyReply } from 'fastify';
import { ApiTags, ApiBearerAuth } from '@nestjs/swagger';
import { ForbiddenException, BadRequestException } from '@nestjs/common';
import { GatewayOutboundMetadataService } from './gateway-outbound-metadata.service';
import { GatewayModuleGuard } from '../guards/gateway-module.guard';
import { ProjectAccessGuard } from '../guards/project-access.guard';
import { SystemOrgContextGuard } from '../guards/system-org-context.guard';
import { RequireModule } from '../guards/require-module.decorator';
import { RequirePermission } from '../guards/require-permission.decorator';
import { MembershipOnly } from '../guards/membership-only.decorator';
import { projectRoleCan, projectRoleCanKey } from '@fairflow/shared';
import { ChatStreamService, type ChatFrame } from './chat-stream.service';
import { ChatAttachmentStorageService } from './chat-attachment-storage.service';
import { AppConfigService } from '../config/app-config.service';
import { trustedClientPointer } from './trusted-client-pointer';
import { MetricsService } from '../metrics/metrics.service';
import { assertChatIntegrationRateLimit } from './chat-rate-limit';
import { appendPiiEgressAudit } from './pii-egress-audit';

type GrpcReq = FastifyRequest & {
  user?: { userId?: string; sessionId?: string };
  __projectRole?: string;
};

// ───────────────────────── FE mappers (snake_case proto → camelCase VM) ──────
// keepCase:true on the loader keeps proto fields snake_case; map them to the
// camelCase view-models the frontend contract (06-frontend-contract §3) expects.

function scopeFe(s: Record<string, unknown> | undefined) {
  if (!s) return undefined;
  return { kind: s.kind, scopeId: s.scope_id };
}

function lastMessageFe(m: Record<string, unknown> | undefined | null) {
  if (!m || !m.id) return null;
  return { id: m.id, text: m.text, senderId: m.sender_id, sentAt: m.sent_at, kind: m.kind };
}

function memberFe(m: Record<string, unknown>) {
  return {
    userId: m.user_id,
    role: m.role,
    joinedAt: m.joined_at,
    leftAt: m.left_at || null,
    lastReadSeq: m.last_read_seq,
  };
}

function conversationFe(c: Record<string, unknown>) {
  const members = Array.isArray(c.members) ? (c.members as Record<string, unknown>[]) : [];
  return {
    id: c.id,
    type: c.type,
    scope: scopeFe(c.scope as Record<string, unknown>),
    projectId: c.project_id || undefined,
    title: c.title,
    avatarUrl: c.avatar_url || undefined,
    dmKey: c.dm_key || undefined,
    createdBy: c.created_by,
    lastMessage: lastMessageFe(c.last_message as Record<string, unknown>),
    lastMessageAt: c.last_message_at,
    unreadCount: c.unread_count ?? 0,
    myRole: c.my_role || undefined,
    archivedAt: c.archived_at || null,
    createdAt: c.created_at,
    updatedAt: c.updated_at,
    ...(members.length ? { members: members.map(memberFe) } : {}),
  };
}

function attachmentFe(a: Record<string, unknown>) {
  return {
    documentId: a.document_id,
    versionId: a.version_id,
    fileName: a.file_name,
    mime: a.mime,
    size: a.size,
  };
}

function entityRefFe(r: Record<string, unknown>) {
  return {
    type: r.type,
    id: r.id,
    label: r.label ?? '',
  };
}

function messageFe(m: Record<string, unknown>) {
  const attachments = Array.isArray(m.attachments)
    ? (m.attachments as Record<string, unknown>[])
    : [];
  const entityRefs = Array.isArray(m.entity_refs)
    ? (m.entity_refs as Record<string, unknown>[])
    : [];
  return {
    id: m.id,
    conversationId: m.conversation_id,
    scope: scopeFe(m.scope as Record<string, unknown>),
    seq: m.seq,
    senderId: m.sender_id,
    senderType: m.sender_type,
    kind: m.kind,
    text: m.text,
    attachments: attachments.map(attachmentFe),
    mentionIds: Array.isArray(m.mention_ids) ? m.mention_ids : [],
    entityRefs: entityRefs.map(entityRefFe),
    replyToId: m.reply_to_id || null,
    clientMessageId: m.client_message_id || undefined,
    editedAt: m.edited_at || null,
    deletedAt: m.deleted_at || null,
    deletedBy: m.deleted_by || undefined,
    sentAt: m.sent_at,
    createdAt: m.created_at,
  };
}

/**
 * Chat BFF — public REST facade for the gRPC chat domain (contracts/chat.md §2.1,
 * 06-frontend-contract §6). Every handler:
 *  - is gated by GatewayModuleGuard + @RequireModule('chat') + @RequirePermission
 *    + ProjectAccessGuard (channels) — the PDP layer (SEC-C-1/5);
 *  - forwards TRUSTED isolation scope to the domain via outbound metadata
 *    (x-project-id / x-organization-id) — never from the body. DEORG-GW-8:
 *    the DM/group corporate boundary (x-organization-id) is the single-tenant
 *    org anchor resolved server-side by SystemOrgContextGuard, never a client
 *    header; the individual/workspace path is dead in single-tenant box;
 *  - maps snake_case proto ↔ camelCase FE view-models.
 *
 * presence + WS/SSE realtime are NOT gRPC: they read/fan-out via Redis
 * (ChatStreamService). After a successful SendMessage the BFF publishes the
 * `message` frame to `chat:conv:{id}`; MarkRead/MarkAllRead publish a `badge`.
 */
@ApiBearerAuth()
@ApiTags('Chat')
@UseGuards(SystemOrgContextGuard, GatewayModuleGuard, ProjectAccessGuard)
@Controller({ path: 'chat', version: '1' })
export class ChatBffController implements OnModuleInit {
  private chat!: Record<string, (x: unknown, m?: unknown) => unknown>;
  private documents!: Record<string, (x: unknown, m?: unknown) => unknown>;
  private org!: Record<string, (x: unknown, m?: unknown) => unknown>;
  private project!: Record<string, (x: unknown, m?: unknown) => unknown>;
  private audit?: { appendEvent: (x: unknown, m?: unknown) => unknown };

  constructor(
    @Inject('CHAT_GRPC') private chatClient: ClientGrpcProxy,
    @Inject('DOCUMENTS_GRPC') private documentsClient: ClientGrpcProxy,
    @Inject('CONTROL_GRPC') private controlClient: ClientGrpcProxy,
    private readonly outboundMeta: GatewayOutboundMetadataService,
    private readonly stream: ChatStreamService,
    private readonly attachmentStorage: ChatAttachmentStorageService,
    // X4: the ONE authoritative name of the documents bucket — a storage pointer
    // arriving in a request BODY is checked against it instead of being trusted.
    private readonly config: AppConfigService,
    private readonly metrics: MetricsService,
    // Last + optional so existing positional specs stay valid (same pattern as crm-bff).
    @Optional() @Inject('AUDIT_GRPC') private auditClient?: ClientGrpcProxy,
  ) {}

  onModuleInit() {
    this.chat = this.chatClient.getService('ChatService');
    this.documents = this.documentsClient.getService('DocumentsGrpc');
    // ResolveCommunicationScope lives on OrganizationGrpc (control), M-CHAT-12.
    this.org = this.controlClient.getService('OrganizationGrpc');
    // ProjectGrpc.ListMembers → member names; used to fill DM conversation titles.
    this.project = this.controlClient.getService('ProjectGrpc');
    this.audit = this.auditClient?.getService('AuditGrpc') as
      | { appendEvent: (x: unknown, m?: unknown) => unknown }
      | undefined;
  }

  /** Outbound metadata: project (channels) + org/workspace (DM/group) isolation. */
  private meta(req: GrpcReq, projectId?: string) {
    return this.outboundMeta.build(req, projectId ? { projectId } : undefined);
  }

  /** True when a conversation is a DM whose title the domain left empty. */
  private isUntitledDm(c: Record<string, unknown>): boolean {
    return c.type === 'dm' && !String(c.title ?? '').trim();
  }

  /** Fill `title` (in place) of untitled DM conversations with the peer's name.
   *
   * The chat domain stores DMs with an empty title (the FE used to derive the
   * display name client-side). Resolve the peer's name server-side from control
   * `ProjectGrpc.ListMembers` so every consumer (host chat dropdown rendering
   * `c.title`, etc.) shows a name. Best-effort: a single ListMembers per request;
   * on any failure the titles are left untouched, never failing the list.
   */
  private async fillDmTitles(
    req: GrpcReq,
    convs: Record<string, unknown>[],
    projectId?: string,
  ): Promise<void> {
    const untitled = convs.filter((c) => this.isUntitledDm(c));
    if (!untitled.length) return;
    try {
      const actorId = req.user?.userId ?? '';
      const r = (await grpcBffCall(
        this.project.listMembers(
          { project_id: projectId ?? '' },
          this.meta(req, projectId),
        ) as never,
      )) as { list?: Record<string, unknown>[] };
      const nameById = new Map<string, string>();
      for (const m of r.list ?? []) {
        const id = String(m.id ?? '');
        const name = String(m.name ?? '').trim();
        if (id && name) nameById.set(id, name);
      }
      for (const c of untitled) {
        const members = Array.isArray(c.members) ? (c.members as Record<string, unknown>[]) : [];
        // The peer is the (only other) DM member whose userId differs from the actor.
        // Note: proto `left_at` is a Long ({low,high}) and is a truthy object even
        // when zero, so it can't be used as a boolean "has left" filter here.
        const peer = members.find((m) => {
          const uid = String(m.user_id ?? '');
          return uid && uid !== actorId;
        });
        const peerId = String(peer?.user_id ?? '');
        const name = peerId ? nameById.get(peerId) : undefined;
        if (name) c.title = name;
      }
    } catch {
      // Best-effort: leave DM titles as-is rather than failing the request.
    }
  }

  // ─────────────────────────── conversations ────────────────────────────────

  @Get('conversations')
  @RequireModule('chat')
  @RequirePermission('chat', 'read')
  async listConversations(
    @Req() req: GrpcReq,
    @Query('projectId') projectId?: string,
    @Query('includeArchived') includeArchived?: string,
    @Query('scopeFilter') scopeFilter?: string,
  ) {
    const r = (await grpcBffCall(
      this.chat.listConversations(
        {
          include_archived: includeArchived === 'true',
          scope_filter: scopeFilter ?? 'current',
        },
        this.meta(req, projectId),
      ) as never,
    )) as { conversations?: Record<string, unknown>[] };
    const conversations = r.conversations ?? [];
    await this.fillDmTitles(req, conversations, projectId);
    return { conversations: conversations.map(conversationFe) };
  }

  @Get('conversations/:id')
  @RequireModule('chat')
  @RequirePermission('chat', 'read')
  async getConversation(
    @Req() req: GrpcReq,
    @Param('id') id: string,
    @Query('projectId') projectId?: string,
  ) {
    const conv = (await grpcBffCall(
      this.chat.getConversation({ id }, this.meta(req, projectId)) as never,
    )) as Record<string, unknown>;
    await this.fillDmTitles(req, [conv], projectId);
    return conversationFe(conv);
  }

  @Post('conversations')
  @RequireModule('chat')
  // dm/group need chat:write, project_channel needs chat:manage. The laxer
  // guard ('write') is enforced declaratively here; the channel case additionally
  // requires chat:manage — checked below via __projectRole (FR-CHAT-050) and
  // re-checked by the domain PEP from x-roles (chat.grpc.controller.canManage).
  @RequirePermission('chat', 'write')
  async createConversation(
    @Req() req: GrpcReq,
    @Body() body: Record<string, unknown>,
    @Query('projectId') projectId?: string,
  ) {
    const type = String(body.type ?? '');
    // FR-CHAT-050: project_channel creation requires chat:manage (not plain write).
    if (type === 'project_channel' && !projectRoleCanKey(req.__projectRole, 'chat', 'manage')) {
      throw new ForbiddenException({
        code: 'PERMISSION_DENIED',
        subject: 'chat',
        action: 'manage',
        message: `Role "${req.__projectRole || 'none'}" cannot create project channels`,
      });
    }
    // SEC-C-2 / FR-CHAT-50: DM/group must stay inside the actor's communication
    // boundary. project_channel isolation is handled by ProjectAccessGuard via
    // x-project-id, so the cross-org check only applies to dm/group.
    if (type === 'dm' || type === 'group') {
      const peers: string[] = [];
      if (body.peerUserId) peers.push(String(body.peerUserId));
      if (Array.isArray(body.memberUserIds)) peers.push(...body.memberUserIds.map(String));
      const scope = (await grpcBffCall(
        this.org.resolveCommunicationScope(
          { actor_user_id: req.user?.userId ?? '', peer_user_ids: peers },
          this.meta(req, projectId),
        ) as never,
      )) as { allowed?: boolean; denied_user_ids?: string[] };
      if (scope.allowed !== true) {
        throw new ForbiddenException({
          code: 'CHAT_FORBIDDEN_CROSS_ORG',
          httpStatus: 403,
          message: 'Нельзя начать беседу с пользователем вне вашей организации',
          details: { deniedUserIds: scope.denied_user_ids ?? [] },
        });
      }
    }
    return conversationFe(
      (await grpcBffCall(
        this.chat.createConversation(
          {
            type: body.type,
            peer_user_id: body.peerUserId ?? '',
            title: body.title ?? '',
            member_user_ids: Array.isArray(body.memberUserIds) ? body.memberUserIds : [],
          },
          this.meta(req, projectId),
        ) as never,
        'write',
      )) as Record<string, unknown>,
    );
  }

  @Post('conversations/:id/members')
  @RequireModule('chat')
  @RequirePermission('chat', 'manage')
  async addMembers(
    @Req() req: GrpcReq,
    @Param('id') id: string,
    @Body() body: Record<string, unknown>,
    @Query('projectId') projectId?: string,
  ) {
    return this.updateMembersRpc(req, id, body, projectId);
  }

  @Delete('conversations/:id/members')
  @RequireModule('chat')
  @MembershipOnly()
  // NB: no @RequirePermission('chat','manage') here — self-leave (участник сам
  // покидает беседу: remove == [self], без add/roleChanges) не должен требовать
  // chat:manage. Удаление ЧУЖИХ участников по-прежнему требует manage (проверка
  // ниже вручную по __projectRole, как в ProjectAccessGuard) + owner/admin в домене.
  async removeMembers(
    @Req() req: GrpcReq,
    @Param('id') id: string,
    @Body() body: Record<string, unknown>,
    @Query('projectId') projectId?: string,
  ) {
    const selfId = req.user?.userId;
    const remove = Array.isArray(body.remove) ? (body.remove as unknown[]) : [];
    const add = Array.isArray(body.add) ? (body.add as unknown[]) : [];
    const roleChanges = Array.isArray(body.roleChanges) ? (body.roleChanges as unknown[]) : [];
    const isSelfLeave =
      !!selfId &&
      add.length === 0 &&
      roleChanges.length === 0 &&
      remove.length === 1 &&
      remove[0] === selfId;
    // Любое изменение состава, кроме собственного выхода, требует chat:manage.
    if (!isSelfLeave && !projectRoleCan(req.__projectRole, 'manage')) {
      throw new ForbiddenException({
        code: 'PERMISSION_DENIED',
        subject: 'chat',
        action: 'manage',
        message: `Role "${req.__projectRole || 'none'}" cannot manage chat`,
      });
    }
    return this.updateMembersRpc(req, id, body, projectId);
  }

  private async updateMembersRpc(
    req: GrpcReq,
    id: string,
    body: Record<string, unknown>,
    projectId?: string,
  ) {
    const add = Array.isArray(body.add) ? (body.add as unknown[]).map(String) : [];
    if (add.length > 0) {
      const scope = (await grpcBffCall(
        this.org.resolveCommunicationScope(
          { actor_user_id: req.user?.userId ?? '', peer_user_ids: add },
          this.meta(req, projectId),
        ) as never,
      )) as { allowed?: boolean; denied_user_ids?: string[] };
      if (scope.allowed !== true) {
        throw new ForbiddenException({
          code: 'CHAT_FORBIDDEN_CROSS_ORG',
          httpStatus: 403,
          message: 'Нельзя добавить пользователя вне вашей организации',
          details: { deniedUserIds: scope.denied_user_ids ?? [] },
        });
      }
    }
    const roleChanges = Array.isArray(body.roleChanges)
      ? (body.roleChanges as Record<string, unknown>[]).map((r) => ({
          user_id: r.userId,
          role: r.role,
        }))
      : [];
    return conversationFe(
      (await grpcBffCall(
        this.chat.updateMembers(
          {
            conversation_id: id,
            add: Array.isArray(body.add) ? body.add : [],
            remove: Array.isArray(body.remove) ? body.remove : [],
            role_changes: roleChanges,
          },
          this.meta(req, projectId),
        ) as never,
        'write',
      )) as Record<string, unknown>,
    );
  }

  @Post('conversations/:id/transfer-ownership')
  @RequireModule('chat')
  @RequirePermission('chat', 'manage')
  async transferOwnership(
    @Req() req: GrpcReq,
    @Param('id') id: string,
    @Body() body: { newOwnerUserId: string },
    @Query('projectId') projectId?: string,
  ) {
    return conversationFe(
      (await grpcBffCall(
        this.chat.transferOwnership(
          { conversation_id: id, new_owner_user_id: body.newOwnerUserId },
          this.meta(req, projectId),
        ) as never,
        'write',
      )) as Record<string, unknown>,
    );
  }

  @Post('conversations/:id/archive')
  @RequireModule('chat')
  @RequirePermission('chat', 'manage')
  async archiveConversation(
    @Req() req: GrpcReq,
    @Param('id') id: string,
    @Query('projectId') projectId?: string,
  ) {
    return conversationFe(
      (await grpcBffCall(
        this.chat.archiveConversation({ conversation_id: id }, this.meta(req, projectId)) as never,
        'write',
      )) as Record<string, unknown>,
    );
  }

  // ───────────────────────────── messages ───────────────────────────────────

  @Get('conversations/:id/messages')
  @RequireModule('chat')
  @RequirePermission('chat', 'read')
  async getMessages(
    @Req() req: GrpcReq,
    @Param('id') id: string,
    @Query('projectId') projectId?: string,
    @Query('beforeSeq') beforeSeq?: string,
    @Query('limit') limit?: string,
  ) {
    const r = (await grpcBffCall(
      this.chat.getMessages(
        {
          conversation_id: id,
          before_seq: beforeSeq ? Number(beforeSeq) : 0,
          limit: limit ? Number(limit) : 50,
        },
        this.meta(req, projectId),
      ) as never,
    )) as { messages?: Record<string, unknown>[] };
    return { messages: (r.messages ?? []).map(messageFe) };
  }

  @Post('conversations/:id/messages')
  @RequireModule('chat')
  @RequirePermission('chat', 'write')
  async sendMessage(
    @Req() req: GrpcReq,
    @Param('id') id: string,
    @Body() body: Record<string, unknown>,
    @Query('projectId') projectId?: string,
  ) {
    const attachments = Array.isArray(body.attachments)
      ? (body.attachments as Record<string, unknown>[]).map((a) => ({
          document_id: a.documentId,
          version_id: a.versionId,
          file_name: a.fileName,
          mime: a.mime,
          size: a.size,
        }))
      : [];
    const msg = messageFe(
      (await grpcBffCall(
        this.chat.sendMessage(
          {
            conversation_id: id,
            text: body.text ?? '',
            client_message_id: body.clientMessageId,
            attachments,
            mention_ids: Array.isArray(body.mentionIds) ? body.mentionIds : [],
            reply_to_id: body.replyToId ?? '',
            // sender_type is decided by the gateway from the actor; end-users → 'user'.
            sender_type: 'user',
          },
          this.meta(req, projectId),
        ) as never,
        'write',
      )) as Record<string, unknown>,
    );
    // Realtime fanout (contracts §3.7/§7): publish the message frame to every
    // member subscribed to chat:conv:{id} on any replica via Redis.
    this.stream.publishToConversation(id, {
      type: 'message',
      conversationId: id,
      message: msg as Record<string, unknown>,
    });
    this.metrics.recordChatMessageSent('user');
    return msg;
  }

  @Post('integration/conversations/:id/messages')
  @RequireModule('chat')
  @RequirePermission('chat.integration', 'invoke')
  async integrationSendMessage(
    @Req() req: GrpcReq,
    @Param('id') id: string,
    @Body() body: Record<string, unknown>,
    @Query('projectId') projectId?: string,
  ) {
    const pid = projectId ?? '';
    const actorId = req.user?.userId ?? '';
    assertChatIntegrationRateLimit(actorId, pid);
    const mentionIds = Array.isArray(body.mentionIds) ? body.mentionIds : [];
    if (mentionIds.length > 1) {
      throw new BadRequestException({
        code: 'CHAT_RATE_LIMITED',
        message: 'Интеграция не может массово упоминать пользователей',
      });
    }
    const attachments = Array.isArray(body.attachments)
      ? (body.attachments as Record<string, unknown>[]).map((a) => ({
          document_id: a.documentId,
          version_id: a.versionId,
          file_name: a.fileName,
          mime: a.mime,
          size: a.size,
        }))
      : [];
    const msg = messageFe(
      (await grpcBffCall(
        this.chat.sendMessage(
          {
            conversation_id: id,
            text: body.text ?? '',
            client_message_id: body.clientMessageId,
            attachments,
            mention_ids: mentionIds,
            reply_to_id: body.replyToId ?? '',
            sender_type: 'integration',
          },
          this.meta(req, projectId),
        ) as never,
        'write',
      )) as Record<string, unknown>,
    );
    this.stream.publishToConversation(id, {
      type: 'message',
      conversationId: id,
      message: msg as Record<string, unknown>,
    });
    this.metrics.recordChatMessageSent('integration');
    return msg;
  }

  @Patch('messages/:id')
  @RequireModule('chat')
  @RequirePermission('chat', 'write')
  async editMessage(
    @Req() req: GrpcReq,
    @Param('id') id: string,
    @Body() body: { text: string },
    @Query('projectId') projectId?: string,
  ) {
    return messageFe(
      (await grpcBffCall(
        this.chat.editMessage(
          { message_id: id, text: body.text },
          this.meta(req, projectId),
        ) as never,
        'write',
      )) as Record<string, unknown>,
    );
  }

  @Delete('messages/:id')
  @RequireModule('chat')
  // self-delete needs chat:write; moderation of others' messages needs chat:moderate.
  // The domain (PEP) decides which applies from x-permissions (canModerate); the
  // 'write' guard is the floor every actor must clear.
  @RequirePermission('chat', 'write')
  async deleteMessage(
    @Req() req: GrpcReq,
    @Param('id') id: string,
    @Query('projectId') projectId?: string,
  ) {
    return messageFe(
      (await grpcBffCall(
        this.chat.deleteMessage({ message_id: id }, this.meta(req, projectId)) as never,
        'write',
      )) as Record<string, unknown>,
    );
  }

  // ─────────────────────── read state / unread ──────────────────────────────

  @Post('conversations/:id/read')
  @RequireModule('chat')
  @RequirePermission('chat', 'read')
  async markRead(
    @Req() req: GrpcReq,
    @Param('id') id: string,
    @Body() body: { uptoSeq: number },
    @Query('projectId') projectId?: string,
  ) {
    const r = (await grpcBffCall(
      this.chat.markRead(
        { conversation_id: id, upto_seq: Number(body.uptoSeq ?? 0) },
        this.meta(req, projectId),
      ) as never,
      'write',
    )) as { unread_count?: number; total_unread?: number };
    this.publishBadge(req, projectId, r.total_unread);
    return { unreadCount: r.unread_count ?? 0, totalUnread: r.total_unread ?? 0 };
  }

  @Post('read-all')
  @RequireModule('chat')
  @RequirePermission('chat', 'read')
  async markAllRead(@Req() req: GrpcReq, @Query('projectId') projectId?: string) {
    const r = (await grpcBffCall(
      this.chat.markAllRead({}, this.meta(req, projectId)) as never,
      'write',
    )) as { updated?: number; total_unread?: number };
    this.publishBadge(req, projectId, r.total_unread ?? 0);
    return { updated: r.updated ?? 0, totalUnread: r.total_unread ?? 0 };
  }

  @Get('unread-count')
  @RequireModule('chat')
  @RequirePermission('chat', 'read')
  async unreadCount(
    @Req() req: GrpcReq,
    @Query('projectId') projectId?: string,
    @Query('scopeFilter') scopeFilter?: string,
  ) {
    const r = (await grpcBffCall(
      this.chat.getUnreadCount(
        { scope_filter: scopeFilter ?? 'current' },
        this.meta(req, projectId),
      ) as never,
    )) as { count?: number; by_project?: Record<string, unknown>[] };
    const byProject = Array.isArray(r.by_project)
      ? r.by_project.map((p) => ({ projectId: p.project_id, count: p.count }))
      : undefined;
    return { count: r.count ?? 0, ...(byProject ? { byProject } : {}) };
  }

  @Get('conversations/:id/read-receipts')
  @RequireModule('chat')
  @RequirePermission('chat', 'read')
  async readReceipts(
    @Req() req: GrpcReq,
    @Param('id') id: string,
    @Query('projectId') projectId?: string,
    @Query('uptoSeq') uptoSeq?: string,
  ) {
    const r = (await grpcBffCall(
      this.chat.getReadReceipts(
        { conversation_id: id, upto_seq: uptoSeq ? Number(uptoSeq) : 0 },
        this.meta(req, projectId),
      ) as never,
    )) as {
      read_by?: Record<string, unknown>[];
      read_count?: number;
      total_members?: number;
      aggregate_only?: boolean;
    };
    return {
      readBy: (r.read_by ?? []).map((m) => ({ userId: m.user_id, lastReadSeq: m.last_read_seq })),
      readCount: r.read_count ?? 0,
      totalMembers: r.total_members ?? 0,
      aggregateOnly: r.aggregate_only ?? false,
    };
  }

  // ─────────────────────── observer / search ────────────────────────────────

  @Get('hierarchy-channels')
  @RequireModule('chat')
  @RequirePermission('chat', 'read')
  async hierarchyChannels(@Req() req: GrpcReq, @Query('projectId') projectId?: string) {
    // BOX (DEORG W-7 / TODO-351): x-overview-* transport removed; hierarchy
    // channels are a cloud surface. Domain fail-closes to empty project scope.
    const r = (await grpcBffCall(
      this.chat.listHierarchyChannels({}, this.meta(req, projectId)) as never,
    )) as { conversations?: Record<string, unknown>[] };
    return { conversations: (r.conversations ?? []).map(conversationFe) };
  }

  @Get('search')
  @RequireModule('chat')
  @RequirePermission('chat', 'read')
  async search(
    @Req() req: GrpcReq,
    @Query('query') query?: string,
    @Query('projectId') projectId?: string,
    @Query('limit') limit?: string,
  ) {
    const r = (await grpcBffCall(
      this.chat.searchMessages(
        { query: query ?? '', limit: limit ? Number(limit) : 25 },
        this.meta(req, projectId),
      ) as never,
    )) as { messages?: Record<string, unknown>[] };
    return { messages: (r.messages ?? []).map(messageFe) };
  }

  // ─────────────────────── attachments (→ documents) ────────────────────────

  @Post('attachments')
  @RequireModule('chat')
  @RequirePermission('chat', 'write')
  async uploadAttachment(
    @Req() req: GrpcReq,
    @Body() body: Record<string, unknown>,
    @Query('projectId') projectId?: string,
  ) {
    // FR-CHAT-16: chat attachments live in documents/MinIO. The FE posts the raw
    // file as multipart/form-data (FormData{file, conversation_id}); the gateway
    // streams the bytes into the PRIVATE documents bucket and hands the resolved
    // storage pointer (bucket/object_key/hash/size/mime) to documents with
    // context_type='chat' + record_id=conversationId, so downloads can be scoped
    // to conversation membership (M-CHAT-8, SEC-C-3).
    //
    // A JSON body carrying a pre-uploaded pointer (bucket/objectKey) is still
    // honoured for backward compatibility — but that pointer is client input and
    // goes through `trustedClientPointer` below (X4), exactly like the CRM BFF's
    // JSON upload branches, because both feed the same `documents.uploadDocument`.
    //
    // The projectId is required for BOTH branches: it is the prefix every object
    // key is held to, so an empty one would degrade that check to `startsWith('/')`.
    if (!projectId || !projectId.trim()) {
      throw new BadRequestException('projectId is required');
    }
    const isMultipart =
      typeof (req as unknown as { isMultipart?: () => boolean }).isMultipart === 'function' &&
      (req as unknown as { isMultipart: () => boolean }).isMultipart();

    let name: unknown;
    let recordId: unknown;
    let bucket: unknown;
    let objectKey: unknown;
    let mimeType: unknown;
    let sizeBytes: unknown;
    let fileHash: unknown;

    if (isMultipart) {
      const file = (await (
        req as unknown as {
          file: () => Promise<
            | {
                filename?: string;
                mimetype?: string;
                toBuffer: () => Promise<Buffer>;
                file?: { truncated?: boolean };
                fields?: Record<string, { value?: unknown } | undefined>;
              }
            | undefined
          >;
        }
      ).file()) as
        | {
            filename?: string;
            mimetype?: string;
            toBuffer: () => Promise<Buffer>;
            file?: { truncated?: boolean };
            fields?: Record<string, { value?: unknown } | undefined>;
          }
        | undefined;

      if (!file) throw new BadRequestException('file is required');

      let buffer: Buffer;
      try {
        buffer = await file.toBuffer();
      } catch (error) {
        const code = (error as { code?: string }).code;
        if (code === 'FST_REQ_FILE_TOO_LARGE' || code === 'FST_FILES_LIMIT') {
          throw new BadRequestException('attachment exceeds the 20 MB size limit');
        }
        throw error;
      }
      if (file.file?.truncated) {
        throw new BadRequestException('attachment exceeds the 20 MB size limit');
      }
      if (buffer.length === 0) throw new BadRequestException('file is empty');

      // Form fields (parsed after the file stream is consumed) or query fallback.
      const fields = file.fields ?? {};
      const fieldVal = (k: string): string | undefined => {
        const v = fields[k]?.value;
        return v == null ? undefined : String(v);
      };
      const conversationId =
        fieldVal('conversation_id') ??
        fieldVal('conversationId') ??
        (typeof body?.conversationId === 'string' ? body.conversationId : undefined) ??
        (req.query as Record<string, string> | undefined)?.conversationId;
      if (!conversationId || !conversationId.trim()) {
        throw new BadRequestException('conversationId is required');
      }

      // SEC-C-3: the actor must be an ACTIVE member of the conversation BEFORE
      // any bytes land under {projectId}/chat/{conversationId}/... — the chat
      // domain is the membership source of truth (GetConversation applies
      // requireMembership; NOT_FOUND/PERMISSION_DENIED map to 404/403 here).
      await grpcBffCall(
        this.chat.getConversation({ id: conversationId }, this.meta(req, projectId)) as never,
      );

      const stored = await this.attachmentStorage.uploadChatAttachment({
        projectId,
        conversationId,
        fileName: file.filename,
        contentType: file.mimetype,
        buffer,
      });

      name = fieldVal('name') ?? file.filename ?? '';
      recordId = conversationId;
      bucket = stored.bucket;
      objectKey = stored.objectKey;
      mimeType = stored.mimeType;
      sizeBytes = stored.sizeBytes;
      fileHash = stored.fileHash;
    } else {
      // Legacy: caller already uploaded to storage and sends a JSON pointer.
      const conversationId = body.conversationId;
      if (!conversationId || !String(conversationId).trim()) {
        throw new BadRequestException('conversationId is required');
      }
      // SEC-C-3: same membership gate as the multipart path — never register a
      // document into a conversation the actor is not an active member of.
      await grpcBffCall(
        this.chat.getConversation(
          { id: String(conversationId) },
          this.meta(req, projectId),
        ) as never,
      );
      name = body.name ?? body.fileName ?? '';
      recordId = conversationId;
      // X4: bucket/objectKey from the body are an ADDRESS the documents domain
      // will later presign from, not metadata — and `DocumentsService.uploadDocument`
      // checks them for non-emptiness only. So they are held here to the one
      // configured bucket and to this conversation's own key prefix: the multipart
      // branch writes `{projectId}/chat/{conversationId}/…`, and anything outside it
      // is another conversation's (or another module's) object, which a member of
      // THIS conversation would be able to presign once it is registered here.
      const pointer = trustedClientPointer({
        allowedBucket: this.config.s3DocumentsBucket,
        requiredKeyPrefix: `${projectId}/chat/${String(conversationId)}/`,
        body,
        defaultMime: 'application/octet-stream',
      });
      bucket = pointer.bucket;
      objectKey = pointer.objectKey;
      mimeType = pointer.mimeType;
      sizeBytes = pointer.sizeBytes;
      fileHash = pointer.fileHash;
    }

    const r = (await grpcBffCall(
      this.documents.uploadDocument(
        {
          project_id: projectId ?? '',
          name,
          context_type: 'chat',
          record_id: recordId,
          bucket,
          object_key: objectKey,
          mime_type: mimeType,
          size_bytes: sizeBytes,
          file_hash: fileHash,
        },
        this.meta(req, projectId),
      ) as never,
      'write',
    )) as { group?: Record<string, unknown>; version?: Record<string, unknown> };
    const version = (r.version ?? {}) as Record<string, unknown>;
    const group = (r.group ?? {}) as Record<string, unknown>;
    return {
      documentId: group.group_id,
      versionId: version.version_id,
      fileName: group.name,
      mime: version.mime_type,
      size: version.size_bytes,
    };
  }

  @Get('attachments/:versionId/download-url')
  @RequireModule('chat')
  @RequirePermission('chat', 'read')
  async attachmentDownloadUrl(
    @Req() req: GrpcReq,
    @Param('versionId') versionId: string,
    @Query('projectId') projectId?: string,
  ) {
    // SEC-C-3: documents enforces conversation membership for context_type='chat'
    // downloads by calling chat.IsConversationMember (fail-closed: non-member or
    // chat unavailable → no presigned URL); x-user-id/x-project-id in the metadata
    // below are what documents forwards to chat for that check.
    const r = (await grpcBffCall(
      this.documents.getDownloadUrl(
        { project_id: projectId ?? '', version_id: versionId, ttl_sec: 0 },
        this.meta(req, projectId),
      ) as never,
    )) as { url?: string; expires_at?: number };
    void appendPiiEgressAudit(this.audit, this.outboundMeta, req, projectId ?? '', {
      channel: 'presigned_url',
      subject: 'chat',
      entityId: versionId,
    });
    return { url: r.url, expiresAt: r.expires_at };
  }

  // ─────────────────────── presence (Redis, gateway-only) ───────────────────

  @Get('conversations/:id/presence')
  @RequireModule('chat')
  @RequirePermission('chat', 'read')
  async presence(
    @Req() req: GrpcReq,
    @Param('id') id: string,
    @Query('projectId') projectId?: string,
  ) {
    // Resolve the conversation members (scoped by the domain), then read their
    // live presence TTL keys from Redis (contracts §3.19). No domain presence RPC.
    const conv = (await grpcBffCall(
      this.chat.getConversation({ id }, this.meta(req, projectId)) as never,
    )) as Record<string, unknown>;
    const members = Array.isArray(conv.members) ? (conv.members as Record<string, unknown>[]) : [];
    const userIds = members
      .filter((m) => toNum(m.left_at) === 0)
      .map((m) => String(m.user_id))
      .filter(Boolean);
    const presence = await this.stream.readPresence(userIds);
    return {
      presence: presence.map((p) => ({
        userId: p.userId,
        online: p.online,
        ...(p.lastSeenAt != null ? { lastSeenAt: p.lastSeenAt } : {}),
      })),
    };
  }

  // ─────────────────────── realtime SSE fallback ────────────────────────────

  // WS /ws/chat is registered on the raw Fastify instance (chat-ws.gateway.ts);
  // this SSE endpoint is the firewall/proxy fallback (read-only frames; sending
  // goes through REST SendMessage, typing degrades — FR-CHAT-40). It subscribes
  // the connection to the user's badge channel + each conversation the user is an
  // active member of, and periodically re-validates membership (SEC-C-4).
  @Get('stream')
  @RequireModule('chat')
  @RequirePermission('chat', 'read')
  async stream_(
    @Req() req: GrpcReq,
    @Res() reply: FastifyReply,
    @Query('projectId') projectId?: string,
  ) {
    const userId = req.user?.userId ?? '';
    const raw = reply.raw;
    raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    raw.write(': connected\n\n');

    const write = (event: string, data: unknown) => {
      if (raw.writableEnded) return;
      raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };

    const unsubscribers: (() => void)[] = [];
    const subscribedConversationIds = new Set<string>();
    let closed = false;
    const onFrame = (frame: ChatFrame) => write(frame.type, frame);

    const unsubscribeConversation = (cid: string) => {
      const idx = unsubscribers.findIndex((u) => (u as { __cid?: string }).__cid === cid);
      if (idx >= 0) {
        unsubscribers[idx]();
        unsubscribers.splice(idx, 1);
      }
      subscribedConversationIds.delete(cid);
    };

    const subscribeConversationChannel = (cid: string) => {
      // `closed`: revalidate может завершиться уже после close() — не подписываем
      // канал на закрытом соединении (иначе Redis-подписка утечёт навсегда).
      if (closed || !cid || subscribedConversationIds.has(cid)) return;
      subscribedConversationIds.add(cid);
      const unsub = this.stream.subscribeConversation(cid, onFrame);
      (unsub as { __cid?: string }).__cid = cid;
      unsubscribers.push(unsub);
    };

    // Badge channel (cross-tab/replica unread sync).
    if (userId) unsubscribers.push(this.stream.subscribeBadge(userId, onFrame));

    // Subscribe to the user's active conversations (membership filter, SEC-C-4).
    const subscribeConversations = async () => {
      try {
        const r = (await grpcBffCall(
          this.chat.listConversations(
            { include_archived: false, scope_filter: 'current' },
            this.meta(req, projectId),
          ) as never,
        )) as { conversations?: Record<string, unknown>[] };
        const nextIds = new Set((r.conversations ?? []).map((c) => String(c.id)).filter(Boolean));
        for (const cid of subscribedConversationIds) {
          if (!nextIds.has(cid)) unsubscribeConversation(cid);
        }
        for (const cid of nextIds) subscribeConversationChannel(cid);
      } catch {
        // Best-effort; the client revalidates via SWR on reconnect.
      }
    };
    await subscribeConversations();
    if (userId) await this.stream.heartbeatPresence(userId);

    const PING_MS = Number.parseInt(process.env.GATEWAY_SSE_PING_MS ?? '25000', 10);
    const ping = setInterval(() => {
      write('ping', { t: Date.now() });
      if (userId) void this.stream.heartbeatPresence(userId);
    }, PING_MS);

    const REVALIDATE_MS = Number.parseInt(process.env.GATEWAY_SSE_REVALIDATE_MS ?? '30000', 10);
    const MAX_TTL_MS = Number.parseInt(process.env.GATEWAY_SSE_MAX_TTL_MS ?? '900000', 10);
    const startedAt = Date.now();
    const close = () => {
      if (closed) return;
      closed = true;
      clearInterval(ping);
      clearInterval(revalidate);
      for (const u of unsubscribers) u();
      if (!raw.writableEnded) raw.end();
    };
    const revalidate = setInterval(() => {
      if (Date.now() - startedAt >= MAX_TTL_MS) {
        write('expired', { reason: 'ttl' });
        close();
        return;
      }
      void subscribeConversations();
    }, REVALIDATE_MS);

    req.raw.on('close', close);
    raw.on('error', close);
  }

  /** Publish an aggregate badge frame for the actor (markRead/markAllRead). */
  private publishBadge(req: GrpcReq, projectId: string | undefined, unread?: number) {
    const userId = req.user?.userId ?? '';
    if (!userId) return;
    this.stream.publishBadge(userId, {
      type: 'badge',
      userId,
      projectId,
      ...(typeof unread === 'number' ? { unread } : {}),
    });
  }
}
