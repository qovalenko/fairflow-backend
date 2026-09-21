import { status } from '@grpc/grpc-js';
import { ChatService } from './chat.service';
import type { ChatCtx } from './chat.types';

const SCOPE = { kind: 'project', scopeId: 'p1' };
const ctx = (userId: string): ChatCtx =>
  ({ userId, scope: SCOPE, causation: undefined }) as unknown as ChatCtx;

const outbox = {
  withOutbox: async (fn: (s?: unknown) => Promise<{ result: unknown; intents?: unknown[] }>) =>
    (await fn()).result,
} as never;
const metrics = { recordChatMessageSent: jest.fn() } as never;

describe('ChatService core API', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('listConversations возвращает пустой список без membership', async () => {
    const mongo = {
      members: jest.fn(async () => ({
        find: () => ({ toArray: async () => [] }),
      })),
      conversations: jest.fn(),
    } as never;
    const svc = new ChatService(mongo, outbox, metrics);
    await expect(svc.listConversations(ctx('u1'), false, 'current')).resolves.toEqual({
      conversations: [],
    });
  });

  it('getConversation NOT_FOUND для чужого scope', async () => {
    const mongo = {
      conversations: jest.fn(async () => ({
        findOne: jest.fn(async () => ({
          _id: 'c1',
          scope: { kind: 'project', scopeId: 'other' },
        })),
      })),
      members: jest.fn(),
    } as never;
    const svc = new ChatService(mongo, outbox, metrics);
    await expect(svc.getConversation(ctx('u1'), 'c1')).rejects.toMatchObject({
      error: { code: status.NOT_FOUND },
    });
  });

  it('createConversation INVALID_ARGUMENT для неизвестного type', async () => {
    const mongo = { conversations: jest.fn(), members: jest.fn(), messages: jest.fn() } as never;
    const svc = new ChatService(mongo, outbox, metrics);
    await expect(svc.createConversation(ctx('u1'), 'unknown')).rejects.toMatchObject({
      error: { code: status.INVALID_ARGUMENT },
    });
  });

  it('createConversation INVALID_ARGUMENT для group без member_user_ids', async () => {
    const mongo = { conversations: jest.fn(), members: jest.fn(), messages: jest.fn() } as never;
    const svc = new ChatService(mongo, outbox, metrics);
    await expect(svc.createConversation(ctx('u1'), 'group')).rejects.toMatchObject({
      error: { code: status.INVALID_ARGUMENT },
    });
  });

  it('sendMessage INVALID_ARGUMENT без client_message_id и без текста/вложений', async () => {
    const conv = { _id: 'c1', scope: SCOPE, projectId: 'p1', seqCounter: 0 };
    const mongo = {
      conversations: jest.fn(async () => ({ findOne: jest.fn(async () => conv) })),
      members: jest.fn(async () => ({
        findOne: jest.fn(async () => ({ userId: 'u1', leftAt: null })),
      })),
      messages: jest.fn(async () => ({ findOne: jest.fn(async () => null) })),
    } as never;
    const svc = new ChatService(mongo, outbox, metrics);
    await expect(svc.sendMessage(ctx('u1'), 'c1', '', '', [], [], undefined, 'user')).rejects.toMatchObject(
      { error: { code: status.INVALID_ARGUMENT } },
    );
    await expect(
      svc.sendMessage(ctx('u1'), 'c1', 'hi', '', [], [], undefined, 'user'),
    ).rejects.toMatchObject({ error: { code: status.INVALID_ARGUMENT } });
  });

  it('getMessages ограничивает limit 1..100', async () => {
    const limit = jest.fn(() => ({ toArray: async () => [] }));
    const messagesColl = {
      find: jest.fn(() => ({ sort: () => ({ limit }) })),
    };
    const mongo = {
      conversations: jest.fn(async () => ({
        findOne: jest.fn(async () => ({ _id: 'c1', scope: SCOPE })),
      })),
      members: jest.fn(async () => ({
        findOne: jest.fn(async () => ({ userId: 'u1', leftAt: null })),
      })),
      messages: jest.fn(async () => messagesColl),
    } as never;
    const svc = new ChatService(mongo, outbox, metrics);
    await svc.getMessages(ctx('u1'), 'c1', 0, 999);
    expect(messagesColl.find).toHaveBeenCalledWith({ conversationId: 'c1' });
    expect(limit).toHaveBeenCalledWith(100);
  });

  it('markRead обнуляет unread и возвращает totalUnread', async () => {
    const member = { userId: 'u1', lastReadSeq: 1, unreadCount: 3, leftAt: null };
    const membersColl = {
      findOne: jest.fn(async () => member),
      updateOne: jest.fn(async () => {
        member.unreadCount = 0;
        member.lastReadSeq = 5;
      }),
      find: jest.fn(() => ({ toArray: async () => [member] })),
    };
    const mongo = {
      conversations: jest.fn(async () => ({
        findOne: jest.fn(async () => ({ _id: 'c1', scope: SCOPE, seqCounter: 5 })),
        find: jest.fn(() => ({ toArray: async () => [{ _id: 'c1', scope: SCOPE }] })),
      })),
      members: jest.fn(async () => membersColl),
      messages: jest.fn(),
    } as never;
    const svc = new ChatService(mongo, outbox, metrics);
    const r = await svc.markRead(ctx('u1'), 'c1', 5);
    expect(r).toMatchObject({ unreadCount: 0, totalUnread: 0 });
  });

  it('getUnreadCount scope=all агрегирует byProject', async () => {
    const members = [
      { conversationId: 'c1', userId: 'u1', unreadCount: 2, leftAt: null },
      { conversationId: 'c2', userId: 'u1', unreadCount: 1, leftAt: null },
    ];
    const mongo = {
      members: jest.fn(async () => ({
        find: jest.fn(() => ({ toArray: async () => members })),
      })),
      conversations: jest.fn(async () => ({
        find: jest.fn(() => ({
          toArray: async () => [
            { _id: 'c1', scope: { kind: 'project', scopeId: 'p1' }, projectId: 'p1' },
            { _id: 'c2', scope: { kind: 'project', scopeId: 'p2' }, projectId: 'p2' },
          ],
        })),
      })),
      messages: jest.fn(),
    } as never;
    const svc = new ChatService(mongo, outbox, metrics);
    const r = await svc.getUnreadCount(ctx('u1'), 'all');
    expect(r.count).toBe(3);
    expect(r.byProject).toEqual(
      expect.arrayContaining([
        { projectId: 'p1', count: 2 },
        { projectId: 'p2', count: 1 },
      ]),
    );
  });

  it('getReadReceipts возвращает readBy для небольших бесед', async () => {
    const members = [
      { userId: 'u1', role: 'owner', joinedAt: 1, leftAt: null, lastReadSeq: 10 },
      { userId: 'u2', role: 'member', joinedAt: 1, leftAt: null, lastReadSeq: 1 },
    ];
    const mongo = {
      conversations: jest.fn(async () => ({
        findOne: jest.fn(async () => ({ _id: 'c1', scope: SCOPE })),
      })),
      members: jest.fn(async () => ({
        findOne: jest.fn(async () => members[0]),
        find: jest.fn(() => ({ toArray: async () => members })),
      })),
      messages: jest.fn(),
    } as never;
    const svc = new ChatService(mongo, outbox, metrics);
    const r = await svc.getReadReceipts(ctx('u1'), 'c1', 5);
    expect(r.aggregateOnly).toBe(false);
    expect(r.readBy).toHaveLength(1);
    expect(r.readCount).toBe(1);
  });

  it('searchMessages возвращает [] для пустого query', async () => {
    const mongo = { members: jest.fn(), messages: jest.fn(), conversations: jest.fn() } as never;
    const svc = new ChatService(mongo, outbox, metrics);
    await expect(svc.searchMessages(ctx('u1'), '   ', 10)).resolves.toEqual({ messages: [] });
  });

  it('isConversationMember false для пустого id и cross-scope', async () => {
    const mongo = {
      conversations: jest.fn(async () => ({
        findOne: jest.fn(async (f: { _id: string }) =>
          f._id === 'c1' ? { _id: 'c1', scope: { kind: 'project', scopeId: 'other' } } : null,
        ),
      })),
      members: jest.fn(async () => ({ findOne: jest.fn() })),
    } as never;
    const svc = new ChatService(mongo, outbox, metrics);
    await expect(svc.isConversationMember(ctx('u1'), '')).resolves.toBe(false);
    await expect(svc.isConversationMember(ctx('u1'), 'c1')).resolves.toBe(false);
  });

  it('isConversationMember true для активного участника', async () => {
    const mongo = {
      conversations: jest.fn(async () => ({
        findOne: jest.fn(async () => ({ _id: 'c1', scope: SCOPE })),
      })),
      members: jest.fn(async () => ({
        findOne: jest.fn(async () => ({ userId: 'u1', leftAt: null })),
      })),
    } as never;
    const svc = new ChatService(mongo, outbox, metrics);
    await expect(svc.isConversationMember(ctx('u1'), 'c1')).resolves.toBe(true);
  });

  it('archiveConversation PERMISSION_DENIED для member', async () => {
    const mongo = {
      conversations: jest.fn(async () => ({
        findOne: jest.fn(async () => ({ _id: 'c1', scope: SCOPE, type: 'group' })),
        updateOne: jest.fn(),
      })),
      members: jest.fn(async () => ({
        findOne: jest.fn(async () => ({ userId: 'u1', role: 'member', leftAt: null })),
        find: jest.fn(() => ({ toArray: async () => [] })),
      })),
      messages: jest.fn(),
    } as never;
    const svc = new ChatService(mongo, outbox, metrics);
    await expect(svc.archiveConversation(ctx('u1'), 'c1')).rejects.toMatchObject({
      error: { code: status.PERMISSION_DENIED },
    });
  });

  it('deleteMessage PERMISSION_DENIED для чужого сообщения без moderate', async () => {
    const msg = {
      _id: 'm1',
      conversationId: 'c1',
      senderId: 'other',
      scope: SCOPE,
      sentAt: Date.now(),
      deletedAt: null,
      text: 'x',
    };
    const mongo = {
      messages: jest.fn(async () => ({ findOne: jest.fn(async () => msg) })),
      members: jest.fn(async () => ({
        findOne: jest.fn(async () => ({ userId: 'u1', leftAt: null })),
      })),
      conversations: jest.fn(async () => ({ findOne: jest.fn(async () => null) })),
    } as never;
    const svc = new ChatService(mongo, outbox, metrics);
    await expect(svc.deleteMessage(ctx('u1'), 'm1', false)).rejects.toMatchObject({
      error: { code: status.PERMISSION_DENIED },
    });
  });
});
