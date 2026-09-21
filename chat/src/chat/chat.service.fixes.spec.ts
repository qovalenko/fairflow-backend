import { status } from '@grpc/grpc-js';
import { ChatService } from './chat.service';
import type { ChatCtx } from './chat.types';

const SCOPE = { kind: 'project', scopeId: 'p1' };
const ctx = (userId: string): ChatCtx =>
  ({ userId, scope: SCOPE, causation: undefined }) as unknown as ChatCtx;

const outbox = { withOutbox: async (fn: (s?: unknown) => Promise<unknown>) => fn() } as never;
const metrics = { recordChatMessageSent: jest.fn() } as never;

describe('ChatService fixes', () => {
  it('markAllRead returns actual totalUnread after updates', async () => {
    const member = { conversationId: 'c1', userId: 'u1', unreadCount: 2, leftAt: null };
    const membersColl = {
      find: jest.fn(() => ({
        toArray: async () => [member],
      })),
      updateOne: jest.fn(async () => {
        member.unreadCount = 0;
      }),
    };
    const convColl = {
      findOne: jest.fn(async () => ({
        _id: 'c1',
        scope: SCOPE,
        seqCounter: 5,
      })),
      find: jest.fn(() => ({
        toArray: async () => [{ _id: 'c1', scope: SCOPE, projectId: 'p1' }],
      })),
    };
    const mongo = {
      members: jest.fn(async () => membersColl),
      conversations: jest.fn(async () => convColl),
      messages: jest.fn(),
    } as never;
    const svc = new ChatService(mongo, outbox, metrics);
    const r = await svc.markAllRead(ctx('u1'));
    expect(r.updated).toBe(1);
    expect(r.totalUnread).toBe(0);
  });

  it('editMessage emits audit payload with originalText before overwriting', async () => {
    const active = {
      _id: 'm2',
      conversationId: 'c1',
      senderId: 'u1',
      scope: SCOPE,
      projectId: 'p1',
      text: 'оригинал',
      sentAt: Date.now(),
      deletedAt: null,
    };
    let findCalls = 0;
    const messagesColl = {
      findOne: jest.fn(async ({ _id }: { _id: string }) => {
        findCalls += 1;
        if (_id !== 'm2') return null;
        return findCalls === 1 ? active : { ...active, text: 'новый', editedAt: Date.now() };
      }),
      updateOne: jest.fn(),
    };
    const membersColl = {
      findOne: jest.fn(async () => ({ userId: 'u1', leftAt: null })),
    };
    let capturedIntents: { type: string; payload: Record<string, unknown> }[] = [];
    const capturingOutbox = {
      withOutbox: async (fn: (s?: unknown) => Promise<{ result: unknown; intents: unknown[] }>) => {
        const r = await fn();
        capturedIntents = r.intents as { type: string; payload: Record<string, unknown> }[];
        return r.result;
      },
    } as never;
    const mongo = {
      messages: jest.fn(async () => messagesColl),
      members: jest.fn(async () => membersColl),
      conversations: jest.fn(async () => ({ findOne: jest.fn(async () => null) })),
    } as never;
    const svc = new ChatService(mongo, capturingOutbox, metrics);
    await svc.editMessage(ctx('u1'), 'm2', 'новый');
    expect(capturedIntents).toHaveLength(1);
    expect(capturedIntents[0]).toMatchObject({
      type: 'chat.message.edited',
      payload: {
        conversationId: 'c1',
        messageId: 'm2',
        originalText: 'оригинал',
        newText: 'новый',
      },
    });
  });

  it('deleteMessage emits audit payload with originalText before tombstone', async () => {
    const active = {
      _id: 'm3',
      conversationId: 'c1',
      senderId: 'u1',
      scope: SCOPE,
      projectId: 'p1',
      text: 'удаляемое',
      sentAt: Date.now(),
      deletedAt: null,
    };
    let findCalls = 0;
    const messagesColl = {
      findOne: jest.fn(async ({ _id }: { _id: string }) => {
        findCalls += 1;
        if (_id !== 'm3') return null;
        return findCalls === 1
          ? active
          : { ...active, text: '', deletedAt: Date.now(), kind: 'system' };
      }),
      updateOne: jest.fn(),
    };
    const membersColl = {
      findOne: jest.fn(async () => ({ userId: 'u1', leftAt: null })),
    };
    let capturedIntents: { type: string; payload: Record<string, unknown> }[] = [];
    const capturingOutbox = {
      withOutbox: async (fn: (s?: unknown) => Promise<{ result: unknown; intents: unknown[] }>) => {
        const r = await fn();
        capturedIntents = r.intents as { type: string; payload: Record<string, unknown> }[];
        return r.result;
      },
    } as never;
    const mongo = {
      messages: jest.fn(async () => messagesColl),
      members: jest.fn(async () => membersColl),
      conversations: jest.fn(async () => ({ findOne: jest.fn(async () => null) })),
    } as never;
    const svc = new ChatService(mongo, capturingOutbox, metrics);
    await svc.deleteMessage(ctx('u1'), 'm3', false);
    expect(capturedIntents).toHaveLength(1);
    expect(capturedIntents[0]).toMatchObject({
      type: 'chat.message.deleted',
      payload: {
        conversationId: 'c1',
        messageId: 'm3',
        originalText: 'удаляемое',
      },
    });
  });

  it('editMessage rejects deleted messages and oversized text', async () => {
    const deleted = {
      _id: 'm1',
      conversationId: 'c1',
      senderId: 'u1',
      scope: SCOPE,
      sentAt: Date.now(),
      deletedAt: Date.now(),
    };
    const active = {
      _id: 'm2',
      conversationId: 'c1',
      senderId: 'u1',
      scope: SCOPE,
      sentAt: Date.now(),
      deletedAt: null,
    };
    const messagesColl = {
      findOne: jest.fn(async ({ _id }: { _id: string }) =>
        _id === 'm1' ? deleted : active,
      ),
      updateOne: jest.fn(),
    };
    const membersColl = {
      findOne: jest.fn(async () => ({ userId: 'u1', leftAt: null })),
    };
    const mongo = {
      messages: jest.fn(async () => messagesColl),
      members: jest.fn(async () => membersColl),
      conversations: jest.fn(async () => ({ findOne: jest.fn() })),
    } as never;
    const svc = new ChatService(mongo, outbox, metrics);
    await expect(svc.editMessage(ctx('u1'), 'm1', 'hi')).rejects.toMatchObject({
      error: { code: status.FAILED_PRECONDITION },
    });
    const big = 'x'.repeat(9000);
    await expect(svc.editMessage(ctx('u1'), 'm2', big)).rejects.toMatchObject({
      error: { code: status.INVALID_ARGUMENT },
    });
  });

  it('sendMessage rolls back seq only when the counter still equals the allocated seq', async () => {
    const conv = { _id: 'c1', scope: SCOPE, projectId: 'p1', seqCounter: 4 };
    const dup = { _id: 'm-dup', conversationId: 'c1', clientMessageId: 'cm1', seq: 5 };
    let firstLookup = true;
    const messagesColl = {
      // первый findOne (пре-чек идемпотентности) → null, второй (после 11000) → дубликат
      findOne: jest.fn(async () => {
        if (firstLookup) {
          firstLookup = false;
          return null;
        }
        return dup;
      }),
      insertOne: jest.fn(async () => {
        throw Object.assign(new Error('dup'), { code: 11000 });
      }),
    };
    const convColl = {
      findOne: jest.fn(async () => conv),
      findOneAndUpdate: jest.fn(async () => ({ ...conv, seqCounter: 5 })),
      updateOne: jest.fn(),
    };
    const membersColl = {
      findOne: jest.fn(async () => ({ userId: 'u1', leftAt: null })),
    };
    const mongo = {
      conversations: jest.fn(async () => convColl),
      members: jest.fn(async () => membersColl),
      messages: jest.fn(async () => messagesColl),
    } as never;
    // sendMessage использует возврат withOutbox → мок должен разворачивать {result}
    const unwrappingOutbox = {
      withOutbox: async (fn: (s?: unknown) => Promise<{ result: unknown }>) => (await fn()).result,
    } as never;
    const svc = new ChatService(mongo, unwrappingOutbox, metrics);
    const r = (await svc.sendMessage(ctx('u1'), 'c1', 'hi', 'cm1', [], [], undefined, 'user')) as {
      id: string;
    };
    expect(r.id).toBe('m-dup');
    // откат строго условный: фильтр включает seqCounter === выданному seq
    expect(convColl.updateOne).toHaveBeenCalledWith(
      { _id: 'c1', seqCounter: 5 },
      { $inc: { seqCounter: -1 } },
      expect.anything(),
    );
  });

  it('sendMessage drops mentionIds for users who are not active members', async () => {
    const conv = { _id: 'c1', scope: SCOPE, projectId: 'p1', seqCounter: 0 };
    const members = [
      { conversationId: 'c1', userId: 'u1', leftAt: null },
      { conversationId: 'c1', userId: 'u2', leftAt: null },
    ];
    let savedMentions: string[] = [];
    const messagesColl = {
      findOne: jest.fn(async () => null),
      insertOne: jest.fn(async (doc: { mentionIds: string[] }) => {
        savedMentions = doc.mentionIds;
      }),
    };
    const convColl = {
      findOne: jest.fn(async () => conv),
      findOneAndUpdate: jest.fn(async () => ({ ...conv, seqCounter: 1 })),
      updateOne: jest.fn(),
    };
    const membersColl = {
      findOne: jest.fn(async () => ({ userId: 'u1', leftAt: null })),
      find: jest.fn(() => ({ toArray: async () => members })),
      updateOne: jest.fn(),
      updateMany: jest.fn(),
    };
    const mongo = {
      conversations: jest.fn(async () => convColl),
      members: jest.fn(async () => membersColl),
      messages: jest.fn(async () => messagesColl),
    } as never;
    const unwrappingOutbox = {
      withOutbox: async (fn: (s?: unknown) => Promise<{ result: unknown }>) => (await fn()).result,
    } as never;
    const svc = new ChatService(mongo, unwrappingOutbox, metrics);
    await svc.sendMessage(ctx('u1'), 'c1', 'hi @u2', 'cm1', [], ['u2', 'u-stranger'], undefined, 'user');
    expect(savedMentions).toEqual(['u2']);
  });

  it('updateMembers blocks removing the sole owner', async () => {
    const members: Array<Record<string, unknown>> = [
      { conversationId: 'c1', userId: 'u-owner', role: 'owner', leftAt: null },
      { conversationId: 'c1', userId: 'u-admin', role: 'admin', leftAt: null },
    ];
    const match = (m: Record<string, unknown>, f: Record<string, unknown>) =>
      Object.entries(f).every(([k, v]) => m[k] === v);
    const membersColl = {
      findOne: jest.fn(async (f: Record<string, unknown>) => members.find((m) => match(m, f)) ?? null),
      countDocuments: jest.fn(async (f: Record<string, unknown>) =>
        members.filter((m) => match(m, f)).length,
      ),
      updateOne: jest.fn(),
      find: jest.fn(() => ({ toArray: async () => members })),
    };
    const conv = {
      _id: 'c1',
      type: 'group',
      scope: SCOPE,
      projectId: 'p1',
      lastMessage: null,
      lastMessageAt: 0,
      archivedAt: null,
      createdAt: 1,
      updatedAt: 1,
    };
    const mongo = {
      members: jest.fn(async () => membersColl),
      conversations: jest.fn(async () => ({
        findOne: jest.fn(async () => conv),
        updateOne: jest.fn(),
      })),
      messages: jest.fn(),
    } as never;
    const svc = new ChatService(mongo, outbox, metrics);
    await expect(svc.updateMembers(ctx('u-admin'), 'c1', [], ['u-owner'], [])).rejects.toMatchObject({
      error: { code: status.FAILED_PRECONDITION },
    });
  });
});
