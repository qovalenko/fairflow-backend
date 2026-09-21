import { Controller, UseInterceptors } from '@nestjs/common';
import { GrpcMethod } from '@nestjs/microservices';
import { status, type Metadata } from '@grpc/grpc-js';
import { RpcException } from '@nestjs/microservices';
import { SnakeCaseResponseInterceptor } from './snake-case.interceptor';
import {
  GW_METADATA,
  RequireModule,
  projectRoleCanKey,
  readGatewayMetadata,
  readProjectId,
  readUserId,
  type OutboxCausation,
} from '@fairflow/shared';
import { ChatService } from './chat.service';
import type { ChatCtx } from './chat.types';
import type { ScopeDoc } from '../mongo/mongo.service';

/** Split a comma/space-separated metadata value into a deduped list. */
function splitMetaList(raw: string): string[] {
  if (!raw) return [];
  const seen = new Set<string>();
  for (const part of raw.split(/[,\s]+/)) {
    const v = part.trim();
    if (v) seen.add(v);
  }
  return [...seen];
}

/**
 * gRPC façade for the chat domain (16 RPC, contracts/chat.md §4). PEP: every
 * handler resolves its isolation scope + actor from TRUSTED gateway metadata
 * (never the body) and delegates to {@link ChatService}. snake_case proto fields
 * (keepCase:true on the loader) are mapped to the service's camelCase here.
 */
@Controller()
@RequireModule('chat')
@UseInterceptors(SnakeCaseResponseInterceptor)
export class ChatGrpcController {
  constructor(private readonly chat: ChatService) {}

  /** Resolve isolation scope: project (x-project-id) → org → workspace. */
  private resolveScope(metadata?: Metadata): ScopeDoc {
    const projectId = readProjectId(metadata);
    if (projectId) return { kind: 'project', scopeId: projectId };
    const orgId = readGatewayMetadata(metadata, GW_METADATA.ORGANIZATION_ID).trim();
    if (orgId) return { kind: 'org', scopeId: orgId };
    const workspaceId = readGatewayMetadata(metadata, GW_METADATA.WORKSPACE_ID).trim();
    if (workspaceId) return { kind: 'workspace', scopeId: workspaceId };
    throw new RpcException({
      code: status.INVALID_ARGUMENT,
      message: 'Не удалось определить scope (x-project-id / x-organization-id / x-workspace-id)',
    });
  }

  private ctx(metadata?: Metadata): ChatCtx {
    const userId = readUserId(metadata);
    if (!userId) {
      throw new RpcException({ code: status.UNAUTHENTICATED, message: 'x-user-id обязателен' });
    }
    const traceId = readGatewayMetadata(metadata, GW_METADATA.TRACE_ID) || undefined;
    const causation: OutboxCausation | undefined = traceId ? { traceId } : undefined;
    return { userId, scope: this.resolveScope(metadata), causation };
  }

  /** Whether the actor carries `chat:moderate` (edit/delete others, FR-CHAT-49). */
  private canModerate(metadata?: Metadata): boolean {
    const perms = splitMetaList(readGatewayMetadata(metadata, GW_METADATA.PERMISSIONS));
    return perms.includes('chat:moderate');
  }

  /** Whether the actor may manage project channels (FR-CHAT-050). */
  private canManage(metadata?: Metadata): boolean {
    const role = readGatewayMetadata(metadata, GW_METADATA.ROLES).trim();
    return projectRoleCanKey(role, 'chat', 'manage');
  }

  @GrpcMethod('ChatService', 'ListConversations')
  async listConversations(
    data: { include_archived?: boolean; scope_filter?: string },
    metadata?: Metadata,
  ) {
    const scopeFilter = data.scope_filter === 'all' ? 'all' : 'current';
    return this.chat.listConversations(
      this.ctx(metadata),
      data.include_archived === true,
      scopeFilter,
    );
  }

  @GrpcMethod('ChatService', 'GetConversation')
  async getConversation(data: { id: string }, metadata?: Metadata) {
    return this.chat.getConversation(this.ctx(metadata), data.id);
  }

  @GrpcMethod('ChatService', 'CreateConversation')
  async createConversation(
    data: {
      type: string;
      peer_user_id?: string;
      title?: string;
      member_user_ids?: string[];
    },
    metadata?: Metadata,
  ) {
    if (data.type === 'project_channel' && !this.canManage(metadata)) {
      throw new RpcException({
        code: status.PERMISSION_DENIED,
        message: 'Создание проектного канала требует chat:manage',
      });
    }
    return this.chat.createConversation(
      this.ctx(metadata),
      data.type,
      data.peer_user_id,
      data.title,
      data.member_user_ids,
    );
  }

  @GrpcMethod('ChatService', 'UpdateMembers')
  async updateMembers(
    data: {
      conversation_id: string;
      add?: string[];
      remove?: string[];
      role_changes?: { user_id?: string; role: string }[];
    },
    metadata?: Metadata,
  ) {
    return this.chat.updateMembers(
      this.ctx(metadata),
      data.conversation_id,
      data.add ?? [],
      data.remove ?? [],
      data.role_changes ?? [],
    );
  }

  @GrpcMethod('ChatService', 'TransferOwnership')
  async transferOwnership(
    data: { conversation_id: string; new_owner_user_id: string },
    metadata?: Metadata,
  ) {
    return this.chat.transferOwnership(
      this.ctx(metadata),
      data.conversation_id,
      data.new_owner_user_id,
      this.canManage(metadata),
    );
  }

  @GrpcMethod('ChatService', 'ArchiveConversation')
  async archiveConversation(data: { conversation_id: string }, metadata?: Metadata) {
    return this.chat.archiveConversation(this.ctx(metadata), data.conversation_id);
  }

  @GrpcMethod('ChatService', 'SendMessage')
  async sendMessage(
    data: {
      conversation_id: string;
      text?: string;
      client_message_id: string;
      attachments?: {
        document_id?: string;
        version_id?: string;
        file_name?: string;
        mime?: string;
        size?: number;
      }[];
      mention_ids?: string[];
      reply_to_id?: string;
      sender_type?: string;
    },
    metadata?: Metadata,
  ) {
    const attachments = (data.attachments ?? []).map((a) => ({
      documentId: a.document_id ?? '',
      versionId: a.version_id ?? '',
      fileName: a.file_name ?? '',
      mime: a.mime ?? '',
      size: Number(a.size ?? 0),
    }));
    const senderType = (data.sender_type as 'user' | 'integration' | 'system') || 'user';
    return this.chat.sendMessage(
      this.ctx(metadata),
      data.conversation_id,
      data.text ?? '',
      data.client_message_id,
      attachments,
      data.mention_ids ?? [],
      data.reply_to_id,
      senderType,
    );
  }

  @GrpcMethod('ChatService', 'GetMessages')
  async getMessages(
    data: { conversation_id: string; before_seq?: number; limit?: number },
    metadata?: Metadata,
  ) {
    return this.chat.getMessages(
      this.ctx(metadata),
      data.conversation_id,
      Number(data.before_seq ?? 0),
      Number(data.limit ?? 50),
    );
  }

  @GrpcMethod('ChatService', 'EditMessage')
  async editMessage(data: { message_id: string; text: string }, metadata?: Metadata) {
    return this.chat.editMessage(this.ctx(metadata), data.message_id, data.text);
  }

  @GrpcMethod('ChatService', 'DeleteMessage')
  async deleteMessage(data: { message_id: string }, metadata?: Metadata) {
    return this.chat.deleteMessage(this.ctx(metadata), data.message_id, this.canModerate(metadata));
  }

  @GrpcMethod('ChatService', 'MarkRead')
  async markRead(data: { conversation_id: string; upto_seq?: number }, metadata?: Metadata) {
    return this.chat.markRead(this.ctx(metadata), data.conversation_id, Number(data.upto_seq ?? 0));
  }

  @GrpcMethod('ChatService', 'MarkAllRead')
  async markAllRead(_data: unknown, metadata?: Metadata) {
    return this.chat.markAllRead(this.ctx(metadata));
  }

  @GrpcMethod('ChatService', 'GetUnreadCount')
  async getUnreadCount(data: { scope_filter?: string }, metadata?: Metadata) {
    const scopeFilter = data.scope_filter === 'all' ? 'all' : 'current';
    return this.chat.getUnreadCount(this.ctx(metadata), scopeFilter);
  }

  @GrpcMethod('ChatService', 'GetReadReceipts')
  async getReadReceipts(
    data: { conversation_id: string; upto_seq?: number },
    metadata?: Metadata,
  ) {
    return this.chat.getReadReceipts(
      this.ctx(metadata),
      data.conversation_id,
      Number(data.upto_seq ?? 0),
    );
  }

  @GrpcMethod('ChatService', 'ListHierarchyChannels')
  async listHierarchyChannels(_data: { overview_project_ids?: string[] }, metadata?: Metadata) {
    // BOX (DEORG W-7): org-overview contour and x-overview-* transport removed;
    // hierarchy channels are a cloud surface (TODO-351).
    return this.chat.listHierarchyChannels(this.ctx(metadata), []);
  }

  @GrpcMethod('ChatService', 'SearchMessages')
  async searchMessages(data: { query?: string; limit?: number }, metadata?: Metadata) {
    return this.chat.searchMessages(this.ctx(metadata), data.query ?? '', Number(data.limit ?? 25));
  }

  @GrpcMethod('ChatService', 'IsConversationMember')
  async isConversationMember(data: { conversation_id?: string }, metadata?: Metadata) {
    // SEC-C-3 seam for documents: actor + scope strictly from trusted metadata
    // (x-user-id / x-project-id forwarded by the calling domain), never the body.
    return {
      is_member: await this.chat.isConversationMember(
        this.ctx(metadata),
        data.conversation_id ?? '',
      ),
    };
  }
}
