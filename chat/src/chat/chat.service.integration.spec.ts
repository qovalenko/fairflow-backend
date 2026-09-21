import { status } from '@grpc/grpc-js';
import type { Db, MongoClient } from 'mongodb';
import { connectEphemeralMongo, describeMongoIntegration, id } from '@fairflow/testing';
import { ChatService } from './chat.service';
import type { ChatCtx } from './chat.types';
import { MongoOutboxStore } from '../outbox/mongo-outbox.store';
import { MetricsService } from '../metrics/metrics.service';

/**
 * Chat integration (QA-CI wave 2 chat-flow) — real Mongo edition.
 *
 * Self-skips via `describeMongoIntegration` unless TEST_MONGO_URL is set. Exercises
 * ChatService + MongoOutboxStore against a throwaway database: message send → outbox
 * `chat.message.created`, membership/unread side-effects, and the listConversations /
 * isConversationMember answers that gateway `/ws/chat` uses for subscribe/revalidate
 * (SEC-C-4 data layer — session jti deny-list lives in gateway+auth, out of scope).
 */

interface ChatMongoAdapter {
  conversations: () => ReturnType<Db['collection']>;
  members: () => ReturnType<Db['collection']>;
  messages: () => ReturnType<Db['collection']>;
  outbox: () => ReturnType<Db['collection']>;
  getClient: () => MongoClient;
}

const metrics = { recordChatMessageSent: jest.fn() } as unknown as MetricsService;

jest.setTimeout(30_000);

describeMongoIntegration('chat integration (real Mongo)', () => {
  let client: MongoClient;
  let db: Db;
  let close: () => Promise<void>;
  let mongo: ChatMongoAdapter;
  let outbox: MongoOutboxStore;
  let service: ChatService;

  const projectId = () => id('proj');
  const scope = (pid: string) => ({ kind: 'project' as const, scopeId: pid });
  const ctx = (userId: string, pid: string): ChatCtx =>
    ({ userId, scope: scope(pid), causation: undefined }) as unknown as ChatCtx;

  beforeAll(async () => {
    const eph = await connectEphemeralMongo('chat');
    client = eph.client;
    db = eph.db;
    close = eph.close;
    mongo = {
      conversations: () => db.collection('conversations'),
      members: () => db.collection('conversation_members'),
      messages: () => db.collection('messages'),
      outbox: () => db.collection('_outbox'),
      getClient: () => client,
    };
    outbox = new MongoOutboxStore(mongo as never);
    service = new ChatService(mongo as never, outbox, metrics);
  }, 60_000);

  afterAll(async () => {
    if (close) await close();
  });

  beforeEach(() => {
    jest.clearAllMocks();
  });

  async function createGroup(
    pid: string,
    ownerId: string,
    memberIds: string[],
    title = 'Канал',
  ) {
    const conv = await service.createConversation(
      ctx(ownerId, pid),
      'group',
      undefined,
      title,
      memberIds,
    );
    return conv.id as string;
  }

  async function outboxRows(pid: string) {
    return mongo.outbox().find({ projectId: pid }).sort({ createdAt: 1 }).toArray();
  }

  // ── sendMessage → outbox (notification fan-out upstream) ─────────────────
  describe('sendMessage → chat.message.created outbox', () => {
    it('persists the message, bumps unread for peers, and emits fan-out payload', async () => {
      const pid = projectId();
      const convId = await createGroup(pid, 'u-sender', ['u-recipient', 'u-other'], 'Общий');

      const msg = await service.sendMessage(
        ctx('u-sender', pid),
        convId,
        'Привет всем',
        'cid-fanout-1',
        [],
        [],
        undefined,
        'user',
      );
      expect(msg.text).toBe('Привет всем');
      expect(msg.seq).toBe(1);

      const stored = await mongo.messages().findOne({ conversationId: convId, seq: 1 });
      expect(stored?.senderId).toBe('u-sender');

      const unreadRecipient = await mongo
        .members()
        .findOne({ conversationId: convId, userId: 'u-recipient' });
      const unreadOther = await mongo.members().findOne({ conversationId: convId, userId: 'u-other' });
      const unreadSender = await mongo.members().findOne({ conversationId: convId, userId: 'u-sender' });
      expect(unreadRecipient?.unreadCount).toBe(1);
      expect(unreadOther?.unreadCount).toBe(1);
      expect(unreadSender?.unreadCount ?? 0).toBe(0);

      const rows = await outboxRows(pid);
      const created = rows.find((r) => r.routingKey === 'chat.message.created');
      expect(created).toBeDefined();
      const env = created?.envelope as {
        payload?: {
          conversationId?: string;
          messageId?: string;
          senderId?: string;
          recipientUserIds?: string[];
          mentionIds?: string[];
          preview?: string;
          scope?: { kind?: string; scopeId?: string };
        };
      };
      expect(env.payload?.conversationId).toBe(convId);
      expect(env.payload?.messageId).toBe(msg.id);
      expect(env.payload?.senderId).toBe('u-sender');
      expect(env.payload?.preview).toBe('Привет всем');
      expect(env.payload?.recipientUserIds?.sort()).toEqual(['u-other', 'u-recipient']);
      expect(env.payload?.mentionIds).toEqual([]);
      expect(env.payload?.scope).toMatchObject({ kind: 'project', scopeId: pid });
    });

    it('includes mentionIds in the outbox fact for @mention notification path', async () => {
      const pid = projectId();
      const convId = await createGroup(pid, 'u-sender', ['u-mentioned']);

      await service.sendMessage(
        ctx('u-sender', pid),
        convId,
        '@u-mentioned смотри',
        'cid-mention-1',
        [],
        ['u-mentioned'],
        undefined,
        'user',
      );

      const row = (await outboxRows(pid)).find((r) => r.routingKey === 'chat.message.created');
      const payload = (row?.envelope as { payload?: { mentionIds?: string[]; isMention?: boolean } })
        ?.payload;
      expect(payload?.mentionIds).toEqual(['u-mentioned']);
      expect(payload?.isMention).toBe(true);
    });

    it('client_message_id idempotency: duplicate send returns same message without second outbox row', async () => {
      const pid = projectId();
      const convId = await createGroup(pid, 'u-sender', ['u-peer']);

      const first = await service.sendMessage(
        ctx('u-sender', pid),
        convId,
        'once',
        'cid-dedup',
        [],
        [],
        undefined,
        'user',
      );
      const second = await service.sendMessage(
        ctx('u-sender', pid),
        convId,
        'once again',
        'cid-dedup',
        [],
        [],
        undefined,
        'user',
      );
      expect(second.id).toBe(first.id);

      const chatRows = (await outboxRows(pid)).filter((r) => r.routingKey === 'chat.message.created');
      expect(chatRows).toHaveLength(1);
    });
  });

  // ── WS subscribe/revalidate data layer (membership PEP in chat domain) ─────
  describe('realtime membership PEP (listConversations / isConversationMember)', () => {
    it('listConversations returns only active memberships for the actor', async () => {
      const pid = projectId();
      const convA = await createGroup(pid, 'u-owner', ['u-member'], 'A');
      await createGroup(pid, 'u-outsider', ['u-other'], 'B');

      const memberList = await service.listConversations(ctx('u-member', pid), false, 'current');
      expect(memberList.conversations.map((c) => c.id)).toEqual([convA]);

      const outsiderList = await service.listConversations(ctx('u-outsider', pid), false, 'current');
      expect(outsiderList.conversations.map((c) => c.id)).not.toContain(convA);
    });

    it('self-leave removes the conversation from listConversations (WS revalidate would drop subscribe)', async () => {
      const pid = projectId();
      const convId = await createGroup(pid, 'u-owner', ['u-leaver', 'u-stays'], 'Leave test');

      expect(await service.isConversationMember(ctx('u-leaver', pid), convId)).toBe(true);
      await service.updateMembers(ctx('u-leaver', pid), convId, [], ['u-leaver'], []);

      expect(await service.isConversationMember(ctx('u-leaver', pid), convId)).toBe(false);
      const afterLeave = await service.listConversations(ctx('u-leaver', pid), false, 'current');
      expect(afterLeave.conversations.map((c) => c.id)).not.toContain(convId);

      // Remaining member still sees the channel — subscribe stays valid for them.
      expect(await service.isConversationMember(ctx('u-stays', pid), convId)).toBe(true);
      const staysList = await service.listConversations(ctx('u-stays', pid), false, 'current');
      expect(staysList.conversations.map((c) => c.id)).toContain(convId);
    });

    it('cross-scope probe: foreign project scope → isConversationMember false (no existence leak)', async () => {
      const pidA = projectId();
      const pidB = projectId();
      const convId = await createGroup(pidA, 'u-a', ['u-b'], 'Secret');

      expect(await service.isConversationMember(ctx('u-b', pidA), convId)).toBe(true);
      expect(await service.isConversationMember(ctx('u-b', pidB), convId)).toBe(false);
    });
  });

  // ── integration sender guard (FR-CHAT-430, kept from wave 1) ─────────────
  describe('integration sender guard', () => {
    it('rejects mass mentions from integration sender', async () => {
      const pid = projectId();
      const convId = await createGroup(pid, 'bot', ['u1'], 'Канал');

      await expect(
        service.sendMessage(
          ctx('bot', pid),
          convId,
          'hi',
          'cid-int-mass',
          [],
          ['u1', 'u2'],
          '',
          'integration',
        ),
      ).rejects.toMatchObject({ error: { code: status.RESOURCE_EXHAUSTED } });
    });
  });
});
