import { Injectable } from '@nestjs/common';
import { status } from '@grpc/grpc-js';
import { RpcException } from '@nestjs/microservices';
import { uuidv7 } from 'uuidv7';
import type { ClientSession } from 'mongodb';
import type { EmitIntent } from '@fairflow/shared';
import {
  MongoService,
  type ConversationDoc,
  type ConversationMemberDoc,
  type MessageDoc,
  type ScopeDoc,
} from '../mongo/mongo.service';
import { MongoOutboxStore } from '../outbox/mongo-outbox.store';
import { MetricsService } from '../metrics/metrics.service';
import type { ChatCtx } from './chat.types';
import { extractEntityRefsFromText } from './entity-refs';

/** Edit/delete window default (FR-CHAT-15), configurable per project later. */
const EDIT_WINDOW_MS = parseInt(process.env.CHAT_EDIT_WINDOW_MS ?? String(15 * 60 * 1000), 10);
/** Read-receipts aggregate-only threshold (NFR-CHAT-12, OQ-C-5). */
const RECEIPT_AGGREGATE_THRESHOLD = parseInt(process.env.CHAT_RECEIPT_AGGREGATE_THRESHOLD ?? '500', 10);
/** Max active members per conversation (NFR-CHAT-120). */
const MAX_MEMBERS = parseInt(process.env.CHAT_MAX_MEMBERS ?? '500', 10);
const MAX_TEXT_BYTES = 8 * 1024; // NFR-CHAT-14

function now(): number {
  return Date.now();
}

function denied(code: number, message: string): RpcException {
  return new RpcException({ code, message });
}

/**
 * Chat domain business logic (contracts/chat.md §3). The PEP invariants:
 *  - every read/write is scoped by `ctx.scope` + `ctx.userId` (isolation, NFR-CHAT-10);
 *  - membership is the visibility gate (`conversation_members{userId,leftAt:null}`);
 *  - `senderId`/`deletedBy` come from `ctx.userId`, never the body (SEC-C-5);
 *  - the single durable fact `chat.message.created` is emitted via outbox
 *    after-commit (at-least-once, NFR-CHAT-5).
 */
@Injectable()
export class ChatService {
  constructor(
    private readonly mongo: MongoService,
    private readonly outbox: MongoOutboxStore,
    private readonly metrics: MetricsService,
  ) {}

  // ── helpers ────────────────────────────────────────────────────────────────

  private scopeMatch(doc: { scope?: ScopeDoc }, scope: ScopeDoc): boolean {
    return doc.scope?.kind === scope.kind && doc.scope?.scopeId === scope.scopeId;
  }

  private async getConversationScoped(id: string, scope: ScopeDoc, ctx?: ChatCtx): Promise<ConversationDoc> {
    const conv = await (await this.mongo.conversations()).findOne({ _id: id });
    if (!conv) {
      throw denied(status.NOT_FOUND, 'Беседа не найдена');
    }
    if (!this.scopeMatch(conv, scope)) {
      if (ctx) await this.emitIsolationDenied(ctx, id, 'cross_scope', conv.scope);
      throw denied(status.NOT_FOUND, 'Беседа не найдена');
    }
    return conv;
  }

  private async requireMembership(
    conversationId: string,
    userId: string,
    ctx?: ChatCtx,
  ): Promise<ConversationMemberDoc> {
    const member = await (await this.mongo.members()).findOne({
      conversationId,
      userId,
      leftAt: null,
    });
    if (!member) {
      if (ctx) {
        const conv = await (await this.mongo.conversations()).findOne({ _id: conversationId });
        if (conv && this.scopeMatch(conv, ctx.scope)) {
          await this.emitIsolationDenied(ctx, conversationId, 'not_member', conv.scope);
        }
      }
      throw denied(status.PERMISSION_DENIED, 'Вы не участник беседы'); // CHAT_NOT_A_MEMBER
    }
    return member;
  }

  /** NFR-CHAT-100: security audit fact for cross-boundary / non-member probes. fail-soft. */
  private async emitIsolationDenied(
    ctx: ChatCtx,
    conversationId: string,
    reason: 'cross_scope' | 'not_member',
    conversationScope?: ScopeDoc,
  ): Promise<void> {
    try {
      await this.outbox.withOutbox(async () => ({
        result: null,
        intents: [
          {
            type: 'chat.isolation.denied',
            source: 'chat',
            projectId: ctx.scope.kind === 'project' ? ctx.scope.scopeId : undefined,
            userId: ctx.userId,
            subject: `conversation/${conversationId}`,
            payload: {
              conversationId,
              reason,
              attemptedScope: ctx.scope,
              conversationScope,
            },
            causation: ctx.causation,
          },
        ],
      }));
    } catch {
      /* audit outage must not block the deny response */
    }
  }

  private async countActiveMembers(conversationId: string): Promise<number> {
    return await (await this.mongo.members()).countDocuments({
      conversationId,
      leftAt: null,
    });
  }

  /** FR-CHAT-280: drop mentionIds that are not active conversation members. */
  private async filterMentionIds(conversationId: string, mentionIds: string[]): Promise<string[]> {
    if (!mentionIds.length) return [];
    const active = await (await this.mongo.members())
      .find({ conversationId, leftAt: null })
      .toArray();
    const memberSet = new Set(active.map((m) => m.userId));
    return mentionIds.filter((id) => memberSet.has(id));
  }

  private toLastMessage(m: MessageDoc) {
    return { id: m._id, text: m.text, senderId: m.senderId, sentAt: m.sentAt, kind: m.kind };
  }

  /** Build the Conversation view for a given viewer (unread/myRole from membership). */
  private async toConversationView(
    conv: ConversationDoc,
    viewerId: string,
    includeMembers = false,
  ) {
    const membersColl = await this.mongo.members();
    const mine = await membersColl.findOne({ conversationId: conv._id, userId: viewerId });
    const view: Record<string, unknown> = {
      id: conv._id,
      type: conv.type,
      scope: conv.scope,
      projectId: conv.projectId ?? '',
      title: conv.title ?? '',
      avatarUrl: conv.avatarUrl ?? '',
      dmKey: conv.dmKey ?? '',
      createdBy: conv.createdBy,
      lastMessage: conv.lastMessage ?? null,
      lastMessageAt: conv.lastMessageAt ?? 0,
      unreadCount: mine?.unreadCount ?? 0,
      myRole: mine?.role ?? 'member',
      archivedAt: conv.archivedAt ?? 0,
      createdAt: conv.createdAt,
      updatedAt: conv.updatedAt,
      members: [],
    };
    if (includeMembers) {
      const members = await membersColl.find({ conversationId: conv._id, leftAt: null }).toArray();
      view.members = members.map((m) => ({
        userId: m.userId,
        role: m.role,
        joinedAt: m.joinedAt,
        leftAt: m.leftAt ?? 0,
        lastReadSeq: m.lastReadSeq,
      }));
    }
    return view;
  }

  private dmKey(a: string, b: string, scopeId: string): string {
    return [a, b].sort().join(':') + ':' + scopeId;
  }

  // ── 3.1 ListConversations ────────────────────────────────────────────────────

  async listConversations(
    ctx: ChatCtx,
    includeArchived: boolean,
    scopeFilter: 'current' | 'all' = 'current',
  ) {
    const membersColl = await this.mongo.members();
    const convColl = await this.mongo.conversations();
    const memberships = await membersColl.find({ userId: ctx.userId, leftAt: null }).toArray();
    const ids = memberships.map((m) => m.conversationId);
    if (ids.length === 0) return { conversations: [] };
    const filter: Record<string, unknown> = { _id: { $in: ids } };
    if (scopeFilter !== 'all') {
      filter['scope.kind'] = ctx.scope.kind;
      filter['scope.scopeId'] = ctx.scope.scopeId;
    }
    if (!includeArchived) filter.archivedAt = { $in: [null, 0] };
    const convs = await convColl.find(filter).sort({ lastMessageAt: -1 }).toArray();
    // includeMembers: FE выводит имя собеседника DM из состава (резолв userId→имя).
    const views = await Promise.all(convs.map((c) => this.toConversationView(c, ctx.userId, true)));
    return { conversations: views };
  }

  // ── 3.2 GetConversation ──────────────────────────────────────────────────────

  async getConversation(ctx: ChatCtx, id: string) {
    const conv = await this.getConversationScoped(id, ctx.scope, ctx);
    await this.requireMembership(id, ctx.userId, ctx);
    return this.toConversationView(conv, ctx.userId, true);
  }

  // ── 3.3 CreateConversation ───────────────────────────────────────────────────

  async createConversation(
    ctx: ChatCtx,
    type: string,
    peerUserId?: string,
    title?: string,
    memberUserIds?: string[],
  ) {
    if (!['dm', 'group', 'project_channel'].includes(type)) {
      throw denied(status.INVALID_ARGUMENT, 'Недопустимый тип беседы');
    }
    if (type === 'dm' && !peerUserId) {
      throw denied(status.INVALID_ARGUMENT, 'dm требует peer_user_id');
    }
    if (type === 'group' && (!memberUserIds || memberUserIds.length === 0)) {
      throw denied(status.INVALID_ARGUMENT, 'group требует member_user_ids');
    }

    const convColl = await this.mongo.conversations();
    const ts = now();

    // DM idempotency by dmKey within scope (FR-CHAT-2). Archived DMs (incl. after
    // FR-CHAT-080 convert) keep a rewritten key so a new pair can be created.
    if (type === 'dm') {
      const key = this.dmKey(ctx.userId, peerUserId!, ctx.scope.scopeId);
      const existing = await convColl.findOne({
        dmKey: key,
        type: 'dm',
        archivedAt: { $in: [null, 0] },
      });
      if (existing) return this.toConversationView(existing, ctx.userId, true);
    }

    const id = uuidv7();
    const projectId = ctx.scope.kind === 'project' ? ctx.scope.scopeId : null;
    const dmKey = type === 'dm' ? this.dmKey(ctx.userId, peerUserId!, ctx.scope.scopeId) : undefined;

    const memberIds = new Set<string>([ctx.userId]);
    if (type === 'dm' && peerUserId) memberIds.add(peerUserId);
    if (type === 'group') for (const u of memberUserIds ?? []) memberIds.add(u);
    if (memberIds.size > MAX_MEMBERS) {
      throw denied(status.RESOURCE_EXHAUSTED, 'Превышен лимит участников беседы');
    }
    // project_channel: creator only at creation; membership managed via UpdateMembers.

    const conv: ConversationDoc = {
      _id: id,
      type: type as ConversationDoc['type'],
      scope: ctx.scope,
      projectId,
      title: title ?? undefined,
      dmKey,
      createdBy: ctx.userId,
      lastMessage: null,
      lastMessageAt: 0,
      seqCounter: 0,
      archivedAt: null,
      createdAt: ts,
      updatedAt: ts,
    };

    const result = await this.outbox.withOutbox(async (session) => {
      try {
        await convColl.insertOne(conv, session ? { session } : {});
      } catch (e) {
        // Race: another creator inserted the same DM first (uniq dmKey).
        if (type === 'dm' && (e as { code?: number }).code === 11000) {
          const existing = await convColl.findOne({
            dmKey,
            type: 'dm',
            archivedAt: { $in: [null, 0] },
          });
          if (existing) return { result: existing, intents: [] as EmitIntent[] };
        }
        throw e;
      }
      const membersColl = await this.mongo.members();
      const memberDocs: ConversationMemberDoc[] = [...memberIds].map((uid) => ({
        _id: uuidv7(),
        conversationId: id,
        userId: uid,
        role: uid === ctx.userId ? 'owner' : 'member',
        joinedAt: ts,
        leftAt: null,
        lastReadSeq: 0,
        lastReadAt: null,
        unreadCount: 0,
        mutedUntil: null,
      }));
      await membersColl.insertMany(memberDocs, session ? { session } : {});

      const intents: EmitIntent[] = [
        {
          type: 'chat.conversation.created',
          source: 'chat',
          projectId: projectId ?? undefined,
          userId: ctx.userId,
          subject: `conversation/${id}`,
          payload: { conversationId: id, type, scope: ctx.scope, createdBy: ctx.userId },
          causation: ctx.causation,
        },
      ];
      return { result: conv, intents };
    });

    return this.toConversationView(result, ctx.userId, true);
  }

  // ── 3.4 UpdateMembers ────────────────────────────────────────────────────────

  async updateMembers(
    ctx: ChatCtx,
    conversationId: string,
    add: string[],
    remove: string[],
    roleChanges: { user_id?: string; userId?: string; role: string }[],
  ) {
    const conv = await this.getConversationScoped(conversationId, ctx.scope, ctx);
    const me = await this.requireMembership(conversationId, ctx.userId, ctx);
    const membersColl = await this.mongo.members();

    // Состав диалога (DM) фиксирован по ТЗ (FR-CHAT-2): участников dm не меняют
    // ни владелец, ни рядовой участник — ни добавить, ни удалить, ни выйти самому.
    if (conv.type === 'dm') {
      throw denied(status.FAILED_PRECONDITION, 'Состав диалога фиксирован');
    }

    // Self-leave: рядовой участник покидает беседу сам. Определяем ДО owner/admin-
    // гейта: add пуст, roleChanges пуст, remove === ровно [ctx.userId].
    // requireMembership уже гарантировал, что уходящий — активный участник.
    const isSelfLeave =
      (add ?? []).length === 0 &&
      (roleChanges ?? []).length === 0 &&
      (remove ?? []).length === 1 &&
      remove[0] === ctx.userId;

    if (isSelfLeave) {
      // Последний активный владелец группы не может уйти, не передав владение.
      if (me.role === 'owner') {
        const otherOwners = await membersColl.countDocuments({
          conversationId,
          role: 'owner',
          leftAt: null,
          userId: { $ne: ctx.userId },
        });
        if (otherOwners === 0) {
          throw denied(status.FAILED_PRECONDITION, 'Передайте владение перед выходом');
        }
      }
      // Активный участник вправе выйти — пропускаем к soft-leave ниже.
    } else if (me.role !== 'owner' && me.role !== 'admin') {
      throw denied(status.PERMISSION_DENIED, 'Недостаточно прав для управления составом');
    }
    const activeMembers = await membersColl.find({ conversationId, leftAt: null }).toArray();
    const activeIds = new Set(activeMembers.map((m) => m.userId));
    let newAdds = 0;
    for (const uid of add ?? []) {
      if (uid && !activeIds.has(uid)) newAdds++;
    }
    if (activeIds.size + newAdds > MAX_MEMBERS) {
      throw denied(status.RESOURCE_EXHAUSTED, 'Превышен лимит участников беседы');
    }
    const ts = now();

    await this.outbox.withOutbox(async (session) => {
      const intents: EmitIntent[] = [];
      const opt = session ? { session } : {};
      for (const uid of add ?? []) {
        await membersColl.updateOne(
          { conversationId, userId: uid },
          {
            $set: { leftAt: null, updatedAt: ts },
            $setOnInsert: {
              _id: uuidv7(),
              conversationId,
              userId: uid,
              role: 'member',
              joinedAt: ts,
              lastReadSeq: 0,
              lastReadAt: null,
              unreadCount: 0,
              mutedUntil: null,
            },
          },
          { ...opt, upsert: true },
        );
        intents.push({
          type: 'chat.member.added',
          source: 'chat',
          projectId: conv.projectId ?? undefined,
          userId: ctx.userId,
          subject: `conversation/${conversationId}`,
          payload: { conversationId, userId: uid },
          causation: ctx.causation,
        });
      }
      for (const uid of remove ?? []) {
        const target = await membersColl.findOne({ conversationId, userId: uid, leftAt: null }, opt);
        if (target?.role === 'owner') {
          const otherOwners = await membersColl.countDocuments(
            { conversationId, role: 'owner', leftAt: null, userId: { $ne: uid } },
            opt,
          );
          if (otherOwners === 0) {
            throw denied(status.FAILED_PRECONDITION, 'Нельзя удалить единственного владельца');
          }
        }
        await membersColl.updateOne({ conversationId, userId: uid }, { $set: { leftAt: ts } }, opt);
        intents.push({
          type: 'chat.member.removed',
          source: 'chat',
          projectId: conv.projectId ?? undefined,
          userId: ctx.userId,
          subject: `conversation/${conversationId}`,
          payload: { conversationId, userId: uid },
          causation: ctx.causation,
        });
      }
      for (const rc of roleChanges ?? []) {
        const uid = rc.user_id ?? rc.userId;
        if (uid)
          await membersColl.updateOne(
            { conversationId, userId: uid },
            { $set: { role: rc.role as ConversationMemberDoc['role'] } },
            opt,
          );
      }
      return { result: null, intents };
    });

    const fresh = await this.getConversationScoped(conversationId, ctx.scope, ctx);
    return this.toConversationView(fresh, ctx.userId, true);
  }

  // ── 3.5 TransferOwnership ────────────────────────────────────────────────────

  async transferOwnership(
    ctx: ChatCtx,
    conversationId: string,
    newOwnerUserId: string,
    canManage = false,
  ) {
    if (!newOwnerUserId?.trim()) {
      throw denied(status.INVALID_ARGUMENT, 'new_owner_user_id обязателен');
    }
    const conv = await this.getConversationScoped(conversationId, ctx.scope, ctx);

    if (conv.type === 'dm') {
      return this.convertDmToGroupWithSuccessor(ctx, conv, newOwnerUserId.trim(), canManage);
    }

    const me = await this.requireMembership(conversationId, ctx.userId, ctx);
    if (me.role !== 'owner') {
      throw denied(status.PERMISSION_DENIED, 'Передавать владение может только владелец');
    }
    const membersColl = await this.mongo.members();
    const target = await membersColl.findOne({
      conversationId,
      userId: newOwnerUserId,
      leftAt: null,
    });
    if (!target) {
      throw denied(status.INVALID_ARGUMENT, 'Новый владелец не является участником');
    }
    const ts = now();
    const convColl = await this.mongo.conversations();
    await this.outbox.withOutbox(async (session) => {
      const opt = session ? { session } : {};
      await membersColl.updateOne(
        { conversationId, userId: newOwnerUserId },
        { $set: { role: 'owner' } },
        opt,
      );
      await membersColl.updateOne(
        { conversationId, userId: ctx.userId },
        { $set: { role: 'admin' } },
        opt,
      );
      await convColl.updateOne({ _id: conversationId }, { $set: { updatedAt: ts } }, opt);
      return { result: null, intents: [] };
    });
    const fresh = await this.getConversationScoped(conversationId, ctx.scope, ctx);
    return this.toConversationView(fresh, ctx.userId, true);
  }

  /**
   * FR-CHAT-080: DM при увольнении/смене ответственного → группа с правопреемником;
   * исходный DM архивируется, история остаётся в DM.
   */
  private async convertDmToGroupWithSuccessor(
    ctx: ChatCtx,
    dm: ConversationDoc,
    newOwnerUserId: string,
    canManage: boolean,
  ) {
    const membersColl = await this.mongo.members();
    const me = await membersColl.findOne({
      conversationId: dm._id,
      userId: ctx.userId,
      leftAt: null,
    });
    if (!me && !canManage) {
      await this.emitIsolationDenied(ctx, dm._id, 'not_member', dm.scope);
      throw denied(status.PERMISSION_DENIED, 'Вы не участник беседы');
    }
    if (me && me.role !== 'owner' && !canManage) {
      throw denied(status.PERMISSION_DENIED, 'Передавать владение может только владелец');
    }

    const active = await membersColl.find({ conversationId: dm._id, leftAt: null }).toArray();
    const memberIds = new Set(active.map((m) => m.userId));
    memberIds.add(newOwnerUserId);
    if (memberIds.size > MAX_MEMBERS) {
      throw denied(status.RESOURCE_EXHAUSTED, 'Превышен лимит участников беседы');
    }

    const ts = now();
    const groupId = uuidv7();
    const title = dm.title?.trim() || 'Переданный диалог';
    const convColl = await this.mongo.conversations();

    const group = await this.outbox.withOutbox(async (session) => {
      const opt = session ? { session } : {};
      await convColl.updateOne(
        { _id: dm._id },
        {
          $set: {
            archivedAt: ts,
            updatedAt: ts,
            // Free the unique dmKey so a new DM for the same pair can be created.
            dmKey: `archived:${dm.dmKey ?? dm._id}:${ts}`,
          },
        },
        opt,
      );

      const groupDoc: ConversationDoc = {
        _id: groupId,
        type: 'group',
        scope: dm.scope,
        projectId: dm.projectId,
        title,
        createdBy: ctx.userId,
        lastMessage: null,
        lastMessageAt: 0,
        seqCounter: 0,
        archivedAt: null,
        createdAt: ts,
        updatedAt: ts,
      };
      await convColl.insertOne(groupDoc, opt);

      const memberDocs: ConversationMemberDoc[] = [...memberIds].map((uid) => ({
        _id: uuidv7(),
        conversationId: groupId,
        userId: uid,
        role: uid === newOwnerUserId ? 'owner' : 'member',
        joinedAt: ts,
        leftAt: null,
        lastReadSeq: 0,
        lastReadAt: null,
        unreadCount: 0,
        mutedUntil: null,
      }));
      await membersColl.insertMany(memberDocs, opt);

      const intents: EmitIntent[] = [
        {
          type: 'chat.conversation.created',
          source: 'chat',
          projectId: dm.projectId ?? undefined,
          userId: ctx.userId,
          subject: `conversation/${groupId}`,
          payload: {
            conversationId: groupId,
            type: 'group',
            scope: dm.scope,
            createdBy: ctx.userId,
            convertedFromConversationId: dm._id,
            successorUserId: newOwnerUserId,
          },
          causation: ctx.causation,
        },
      ];
      return { result: groupDoc, intents };
    });

    return this.toConversationView(group, ctx.userId, true);
  }

  // ── 3.6 ArchiveConversation ──────────────────────────────────────────────────

  async archiveConversation(ctx: ChatCtx, conversationId: string) {
    await this.getConversationScoped(conversationId, ctx.scope, ctx);
    const me = await this.requireMembership(conversationId, ctx.userId, ctx);
    if (me.role !== 'owner' && me.role !== 'admin') {
      throw denied(status.PERMISSION_DENIED, 'Архивировать может владелец/админ');
    }
    const ts = now();
    await (await this.mongo.conversations()).updateOne(
      { _id: conversationId },
      { $set: { archivedAt: ts, updatedAt: ts } },
    );
    const fresh = await this.getConversationScoped(conversationId, ctx.scope, ctx);
    return this.toConversationView(fresh, ctx.userId, true);
  }

  // ── 3.7 SendMessage ──────────────────────────────────────────────────────────

  async sendMessage(
    ctx: ChatCtx,
    conversationId: string,
    text: string,
    clientMessageId: string,
    attachments: MessageDoc['attachments'],
    mentionIds: string[],
    replyToId: string | undefined,
    senderType: MessageDoc['senderType'],
  ) {
    if (!clientMessageId) {
      throw denied(status.INVALID_ARGUMENT, 'client_message_id обязателен');
    }
    const hasText = (text ?? '').trim().length > 0;
    if (!hasText && (!attachments || attachments.length === 0)) {
      throw denied(status.INVALID_ARGUMENT, 'Пустое сообщение');
    }
    if (Buffer.byteLength(text ?? '', 'utf8') > MAX_TEXT_BYTES) {
      throw denied(status.INVALID_ARGUMENT, 'Сообщение превышает лимит 8 КБ');
    }
    if (senderType === 'integration' && (mentionIds ?? []).length > 1) {
      throw denied(
        status.RESOURCE_EXHAUSTED,
        'Интеграция не может массово упоминать пользователей',
      );
    }

    const conv = await this.getConversationScoped(conversationId, ctx.scope, ctx);
    await this.requireMembership(conversationId, ctx.userId, ctx);
    const sanitizedMentions = await this.filterMentionIds(conversationId, mentionIds ?? []);

    const messagesColl = await this.mongo.messages();
    // Idempotency: repeated client_message_id → return existing, no dup emit.
    const existing = await messagesColl.findOne({ conversationId, clientMessageId });
    if (existing) return this.toMessageView(existing);

    const convColl = await this.mongo.conversations();
    const membersColl = await this.mongo.members();
    const ts = now();

    const inserted = await this.outbox.withOutbox(async (session) => {
      const opt: { session?: ClientSession } = session ? { session } : {};
      // Atomic seq assignment via $inc on the conversation counter (OQ-C-2).
      const counter = await convColl.findOneAndUpdate(
        { _id: conversationId },
        { $inc: { seqCounter: 1 } },
        { ...opt, returnDocument: 'after' },
      );
      const seq = counter?.seqCounter ?? 1;

      const message: MessageDoc = {
        _id: uuidv7(),
        conversationId,
        scope: conv.scope,
        projectId: conv.projectId ?? null,
        seq,
        senderId: ctx.userId,
        senderType: senderType ?? 'user',
        kind: 'text',
        text: text ?? '',
        attachments: attachments ?? [],
        mentionIds: sanitizedMentions,
        entityRefs: extractEntityRefsFromText(text ?? ''),
        replyToId: replyToId ?? null,
        clientMessageId,
        editedAt: null,
        deletedAt: null,
        deletedBy: null,
        sentAt: ts,
        createdAt: ts,
      };
      try {
        await messagesColl.insertOne(message, opt);
      } catch (e) {
        if ((e as { code?: number }).code === 11000) {
          // Concurrent duplicate: roll back the seq counter we incremented above.
          // Guarded on seqCounter === our seq: if a parallel send already advanced
          // the counter, an unconditional decrement would hand its seq out twice.
          await convColl.updateOne(
            { _id: conversationId, seqCounter: seq },
            { $inc: { seqCounter: -1 } },
            opt,
          );
          const dup = await messagesColl.findOne({ conversationId, clientMessageId });
          if (dup) return { result: dup, intents: [] as EmitIntent[] };
        }
        throw e;
      }

      await convColl.updateOne(
        { _id: conversationId },
        { $set: { lastMessage: this.toLastMessage(message), lastMessageAt: ts, updatedAt: ts } },
        opt,
      );
      // write fan-out: bump unreadCount for every member except the author (≤ NFR-CHAT-12).
      await membersColl.updateMany(
        { conversationId, leftAt: null, userId: { $ne: ctx.userId } },
        { $inc: { unreadCount: 1 } },
        opt,
      );

      // recipientUserIds = members minus author (for notification fan-out).
      const recipients = (
        await membersColl.find({ conversationId, leftAt: null }, opt).toArray()
      )
        .map((m) => m.userId)
        .filter((u) => u !== ctx.userId);

      const intents: EmitIntent[] = [
        {
          type: 'chat.message.created',
          source: 'chat',
          projectId: conv.projectId ?? undefined,
          userId: ctx.userId,
          // Idempotency carried by clientMessageId → no duplicate emit on retry.
          idempotencyKey: clientMessageId,
          subject: `conversation/${conversationId}`,
          payload: {
            conversationId,
            messageId: message._id,
            seq,
            senderId: ctx.userId,
            recipientUserIds: recipients,
            mentionIds: message.mentionIds,
            isMention: message.mentionIds.length > 0,
            scope: conv.scope,
            preview: message.text.slice(0, 280),
            entityRefs: message.entityRefs ?? [],
            conversationTitle: conv.title ?? '',
          },
          causation: ctx.causation,
        },
      ];
      return { result: message, intents };
    });

    this.metrics.recordChatMessageSent(senderType ?? 'user');
    return this.toMessageView(inserted);
  }

  // ── 3.8 GetMessages ──────────────────────────────────────────────────────────

  async getMessages(ctx: ChatCtx, conversationId: string, beforeSeq: number, limit: number) {
    await this.getConversationScoped(conversationId, ctx.scope, ctx);
    await this.requireMembership(conversationId, ctx.userId, ctx);
    const messagesColl = await this.mongo.messages();
    const cap = Math.min(Math.max(limit || 50, 1), 100);
    const filter: Record<string, unknown> = { conversationId };
    if (beforeSeq && beforeSeq > 0) filter.seq = { $lt: beforeSeq };
    const docs = await messagesColl.find(filter).sort({ seq: -1 }).limit(cap).toArray();
    return { messages: docs.map((m) => this.toMessageView(m)) };
  }

  private async refreshLastMessage(conversationId: string, session?: ClientSession) {
    const opt = session ? { session } : {};
    const messagesColl = await this.mongo.messages();
    const convColl = await this.mongo.conversations();
    const latest = (
      await messagesColl
        .find({ conversationId, deletedAt: { $in: [null, 0] } }, opt)
        .sort({ seq: -1 })
        .limit(1)
        .toArray()
    )[0];
    const ts = now();
    if (!latest) {
      await convColl.updateOne(
        { _id: conversationId },
        { $set: { lastMessage: null, lastMessageAt: 0, updatedAt: ts } },
        opt,
      );
      return;
    }
    await convColl.updateOne(
      { _id: conversationId },
      {
        $set: {
          lastMessage: this.toLastMessage(latest),
          lastMessageAt: latest.sentAt,
          updatedAt: ts,
        },
      },
      opt,
    );
  }

  // ── 3.9 EditMessage ──────────────────────────────────────────────────────────

  async editMessage(ctx: ChatCtx, messageId: string, text: string) {
    const messagesColl = await this.mongo.messages();
    const msg = await messagesColl.findOne({ _id: messageId });
    if (!msg || !this.scopeMatch(msg, ctx.scope)) {
      throw denied(status.NOT_FOUND, 'Сообщение не найдено');
    }
    await this.requireMembership(msg.conversationId, ctx.userId, ctx);
    if (msg.senderId !== ctx.userId) {
      throw denied(status.PERMISSION_DENIED, 'Редактировать можно только своё сообщение'); // CHAT_FORBIDDEN_NOT_AUTHOR
    }
    if (msg.deletedAt) {
      throw denied(status.FAILED_PRECONDITION, 'Нельзя редактировать удалённое сообщение');
    }
    if (Buffer.byteLength(text ?? '', 'utf8') > MAX_TEXT_BYTES) {
      throw denied(status.INVALID_ARGUMENT, 'Сообщение превышает лимит 8 КБ');
    }
    if (EDIT_WINDOW_MS > 0 && now() - msg.sentAt > EDIT_WINDOW_MS) {
      throw denied(status.FAILED_PRECONDITION, 'Окно редактирования истекло'); // CHAT_EDIT_WINDOW_EXPIRED
    }
    const ts = now();
    const originalText = msg.text ?? '';
    const conv = await (await this.mongo.conversations()).findOne({ _id: msg.conversationId });
    const wasLast = conv?.lastMessage?.id === messageId;
    await this.outbox.withOutbox(async (session) => {
      const opt = session ? { session } : {};
      await messagesColl.updateOne(
        { _id: messageId },
        { $set: { text, editedAt: ts, entityRefs: extractEntityRefsFromText(text ?? '') } },
        opt,
      );
      if (wasLast) await this.refreshLastMessage(msg.conversationId, session ?? undefined);
      const intents: EmitIntent[] = [
        {
          type: 'chat.message.edited',
          source: 'chat',
          projectId: msg.projectId ?? undefined,
          userId: ctx.userId,
          subject: `conversation/${msg.conversationId}`,
          payload: {
            conversationId: msg.conversationId,
            messageId,
            editedAt: ts,
            originalText,
            newText: text,
          },
          causation: ctx.causation,
        },
      ];
      return { result: null, intents };
    });
    const fresh = await messagesColl.findOne({ _id: messageId });
    return this.toMessageView(fresh!);
  }

  // ── 3.10 DeleteMessage ───────────────────────────────────────────────────────

  async deleteMessage(ctx: ChatCtx, messageId: string, canModerate: boolean) {
    const messagesColl = await this.mongo.messages();
    const msg = await messagesColl.findOne({ _id: messageId });
    if (!msg || !this.scopeMatch(msg, ctx.scope)) {
      throw denied(status.NOT_FOUND, 'Сообщение не найдено');
    }
    await this.requireMembership(msg.conversationId, ctx.userId, ctx);
    const isAuthor = msg.senderId === ctx.userId;
    if (!isAuthor && !canModerate) {
      throw denied(status.PERMISSION_DENIED, 'Удалять чужое может только модератор'); // CHAT_FORBIDDEN_NOT_AUTHOR
    }
    if (isAuthor && EDIT_WINDOW_MS > 0 && now() - msg.sentAt > EDIT_WINDOW_MS && !canModerate) {
      throw denied(status.FAILED_PRECONDITION, 'Окно редактирования истекло');
    }
    const ts = now();
    const originalText = msg.text ?? '';
    const conv = await (await this.mongo.conversations()).findOne({ _id: msg.conversationId });
    const wasLast = conv?.lastMessage?.id === messageId;
    await this.outbox.withOutbox(async (session) => {
      const opt = session ? { session } : {};
      await messagesColl.updateOne(
        { _id: messageId },
        { $set: { deletedAt: ts, deletedBy: ctx.userId, text: '', kind: 'system', attachments: [] } },
        opt,
      );
      if (wasLast) await this.refreshLastMessage(msg.conversationId, session ?? undefined);
      const intents: EmitIntent[] = [
        {
          type: 'chat.message.deleted',
          source: 'chat',
          projectId: msg.projectId ?? undefined,
          userId: ctx.userId,
          subject: `conversation/${msg.conversationId}`,
          payload: {
            conversationId: msg.conversationId,
            messageId,
            deletedAt: ts,
            deletedBy: ctx.userId,
            originalText,
          },
          causation: ctx.causation,
        },
      ];
      return { result: null, intents };
    });
    const fresh = await messagesColl.findOne({ _id: messageId });
    return this.toMessageView(fresh!);
  }

  // ── 3.11 MarkRead ────────────────────────────────────────────────────────────

  async markRead(ctx: ChatCtx, conversationId: string, uptoSeq: number) {
    await this.getConversationScoped(conversationId, ctx.scope, ctx);
    const member = await this.requireMembership(conversationId, ctx.userId, ctx);
    const membersColl = await this.mongo.members();
    const newSeq = Math.max(member.lastReadSeq ?? 0, uptoSeq ?? 0);
    await membersColl.updateOne(
      { conversationId, userId: ctx.userId },
      { $set: { lastReadSeq: newSeq, lastReadAt: now(), unreadCount: 0 } },
    );
    const total = await this.sumUnread(ctx);
    return { unreadCount: 0, totalUnread: total };
  }

  // ── 3.12 MarkAllRead ─────────────────────────────────────────────────────────

  async markAllRead(ctx: ChatCtx) {
    const membersColl = await this.mongo.members();
    const convColl = await this.mongo.conversations();
    const mine = await membersColl
      .find({ userId: ctx.userId, leftAt: null, unreadCount: { $gt: 0 } })
      .toArray();
    let updated = 0;
    for (const m of mine) {
      const conv = await convColl.findOne({ _id: m.conversationId });
      if (!conv || !this.scopeMatch(conv, ctx.scope)) continue;
      await membersColl.updateOne(
        { conversationId: m.conversationId, userId: ctx.userId },
        { $set: { lastReadSeq: conv.seqCounter, lastReadAt: now(), unreadCount: 0 } },
      );
      updated += 1;
    }
    const totalUnread = await this.sumUnread(ctx);
    return { updated, totalUnread };
  }

  // ── 3.13 GetUnreadCount ──────────────────────────────────────────────────────

  private async sumUnread(ctx: ChatCtx): Promise<number> {
    const membersColl = await this.mongo.members();
    const convColl = await this.mongo.conversations();
    const mine = await membersColl.find({ userId: ctx.userId, leftAt: null }).toArray();
    if (mine.length === 0) return 0;
    const convs = await convColl
      .find({
        _id: { $in: mine.map((m) => m.conversationId) },
        'scope.kind': ctx.scope.kind,
        'scope.scopeId': ctx.scope.scopeId,
      })
      .toArray();
    const inScope = new Set(convs.map((c) => c._id));
    return mine.filter((m) => inScope.has(m.conversationId)).reduce((s, m) => s + (m.unreadCount ?? 0), 0);
  }

  async getUnreadCount(ctx: ChatCtx, scopeFilter: 'current' | 'all' = 'current') {
    if (scopeFilter !== 'all') {
      const count = await this.sumUnread(ctx);
      return { count, byProject: [] };
    }
    const membersColl = await this.mongo.members();
    const convColl = await this.mongo.conversations();
    const mine = await membersColl.find({ userId: ctx.userId, leftAt: null }).toArray();
    if (mine.length === 0) return { count: 0, byProject: [] };
    const convs = await convColl
      .find({ _id: { $in: mine.map((m) => m.conversationId) } })
      .toArray();
    const convById = new Map(convs.map((c) => [c._id, c]));
    const byProject = new Map<string, number>();
    let count = 0;
    for (const m of mine) {
      const conv = convById.get(m.conversationId);
      if (!conv || conv.scope?.kind !== 'project') continue;
      const pid = String(conv.projectId ?? conv.scope?.scopeId ?? '');
      if (!pid) continue;
      const unread = m.unreadCount ?? 0;
      count += unread;
      byProject.set(pid, (byProject.get(pid) ?? 0) + unread);
    }
    return {
      count,
      byProject: [...byProject.entries()].map(([projectId, unread]) => ({ projectId, count: unread })),
    };
  }

  // ── 3.14 GetReadReceipts ─────────────────────────────────────────────────────

  async getReadReceipts(ctx: ChatCtx, conversationId: string, uptoSeq: number) {
    await this.getConversationScoped(conversationId, ctx.scope, ctx);
    await this.requireMembership(conversationId, ctx.userId, ctx);
    const membersColl = await this.mongo.members();
    const all = await membersColl.find({ conversationId, leftAt: null }).toArray();
    const totalMembers = all.length;
    const aggregateOnly = totalMembers > RECEIPT_AGGREGATE_THRESHOLD;
    const readMembers = all.filter((m) => (m.lastReadSeq ?? 0) >= (uptoSeq ?? 0));
    return {
      readBy: aggregateOnly
        ? []
        : readMembers.map((m) => ({
            userId: m.userId,
            role: m.role,
            joinedAt: m.joinedAt,
            leftAt: m.leftAt ?? 0,
            lastReadSeq: m.lastReadSeq,
          })),
      readCount: readMembers.length,
      totalMembers,
      aggregateOnly,
    };
  }

  // ── 3.15 ListHierarchyChannels ───────────────────────────────────────────────

  async listHierarchyChannels(ctx: ChatCtx, overviewProjectIds: string[]) {
    // Observer: read-only channels for the VERIFIED project set (from metadata).
    // Not materialized in conversation_members → no unread/myRole/cursors (БП-18).
    if (!overviewProjectIds || overviewProjectIds.length === 0) return { conversations: [] };
    const convColl = await this.mongo.conversations();
    const convs = await convColl
      .find({ type: 'project_channel', 'scope.scopeId': { $in: overviewProjectIds } })
      .sort({ lastMessageAt: -1 })
      .toArray();
    return {
      conversations: convs.map((c) => ({
        id: c._id,
        type: c.type,
        scope: c.scope,
        projectId: c.projectId ?? '',
        title: c.title ?? '',
        avatarUrl: c.avatarUrl ?? '',
        dmKey: '',
        createdBy: c.createdBy,
        lastMessage: c.lastMessage ?? null,
        lastMessageAt: c.lastMessageAt ?? 0,
        unreadCount: 0,
        myRole: '',
        archivedAt: c.archivedAt ?? 0,
        createdAt: c.createdAt,
        updatedAt: c.updatedAt,
        members: [],
      })),
    };
  }

  // ── 3.16 SearchMessages ──────────────────────────────────────────────────────

  async searchMessages(ctx: ChatCtx, query: string, limit: number) {
    if (!query || !query.trim()) return { messages: [] };
    const membersColl = await this.mongo.members();
    const messagesColl = await this.mongo.messages();
    const memberships = await membersColl.find({ userId: ctx.userId, leftAt: null }).toArray();
    const convIds = memberships.map((m) => m.conversationId);
    if (convIds.length === 0) return { messages: [] };
    const cap = Math.min(Math.max(limit || 25, 1), 50);
    const docs = await messagesColl
      .find({
        conversationId: { $in: convIds },
        deletedAt: { $in: [null, 0] },
        $text: { $search: query },
        'scope.kind': ctx.scope.kind,
        'scope.scopeId': ctx.scope.scopeId,
      })
      .limit(cap)
      .toArray();
    return { messages: docs.map((m) => this.toMessageView(m)) };
  }

  // ── 3.17 IsConversationMember (chat↔documents seam, SEC-C-3) ─────────────────

  /**
   * Membership probe for other domains (documents download gate). Never throws
   * for a non-member: returns false for an unknown / out-of-scope conversation
   * or a non-member, so the caller can mask existence (404) fail-closed without
   * an oracle distinguishing "no such conversation" from "not a member".
   */
  async isConversationMember(ctx: ChatCtx, conversationId: string): Promise<boolean> {
    if (!conversationId || !conversationId.trim()) return false;
    const conv = await (await this.mongo.conversations()).findOne({ _id: conversationId });
    if (!conv || !this.scopeMatch(conv, ctx.scope)) return false;
    const member = await (await this.mongo.members()).findOne({
      conversationId,
      userId: ctx.userId,
      leftAt: null,
    });
    return member != null;
  }

  // ── view mapping ─────────────────────────────────────────────────────────────

  private toMessageView(m: MessageDoc) {
    return {
      id: m._id,
      conversationId: m.conversationId,
      scope: m.scope,
      seq: m.seq,
      senderId: m.senderId,
      senderType: m.senderType,
      kind: m.kind,
      text: m.text,
      attachments: m.attachments ?? [],
      mentionIds: m.mentionIds ?? [],
      entityRefs: m.entityRefs ?? [],
      replyToId: m.replyToId ?? '',
      clientMessageId: m.clientMessageId,
      editedAt: m.editedAt ?? 0,
      deletedAt: m.deletedAt ?? 0,
      deletedBy: m.deletedBy ?? '',
      sentAt: m.sentAt,
      createdAt: m.createdAt,
    };
  }
}
