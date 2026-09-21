import { status } from '@grpc/grpc-js';
import { ChatService } from './chat.service';
import type { ChatCtx } from './chat.types';

const SCOPE = { kind: 'project', scopeId: 'p1' };
const ctx = (userId: string): ChatCtx =>
  ({ userId, scope: SCOPE, causation: undefined }) as unknown as ChatCtx;

const outbox = {
  withOutbox: async (fn: (s?: unknown) => Promise<{ result: unknown }>) => (await fn()).result,
} as never;
const metrics = { recordChatMessageSent: jest.fn() } as never;

describe('ChatService round3', () => {
  it('createConversation supports self-DM (FR-CHAT-030)', async () => {
    let insertedMembers: string[] = [];
    const membersColl = {
      insertMany: jest.fn(async (docs: { userId: string }[]) => {
        insertedMembers = docs.map((d) => d.userId);
      }),
      findOne: jest.fn(async () => ({ userId: 'u-self', unreadCount: 0, role: 'owner' })),
      find: jest.fn(() => ({ toArray: async () => [] })),
    };
    const convColl = {
      findOne: jest.fn(async () => null),
      insertOne: jest.fn(),
    };
    const mongo = {
      conversations: jest.fn(async () => convColl),
      members: jest.fn(async () => membersColl),
      messages: jest.fn(),
    } as never;
    const capturingOutbox = {
      withOutbox: async (fn: (s?: unknown) => Promise<{ result: unknown }>) => (await fn()).result,
    } as never;
    const svc = new ChatService(mongo, capturingOutbox, metrics);
    await svc.createConversation(ctx('u-self'), 'dm', 'u-self');
    expect(insertedMembers).toEqual(['u-self']);
  });

  it('updateMembers rejects when active + add exceeds MAX_MEMBERS (NFR-CHAT-120)', async () => {
    const members = Array.from({ length: 500 }, (_, i) => ({
      conversationId: 'c1',
      userId: `u${i}`,
      role: i === 0 ? 'admin' : 'member',
      leftAt: null,
    }));
    const membersColl = {
      findOne: jest.fn(async (f: { userId?: string }) =>
        members.find((m) => m.userId === f.userId) ?? null,
      ),
      countDocuments: jest.fn(),
      find: jest.fn(() => ({ toArray: async () => members })),
      updateOne: jest.fn(),
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
    await expect(svc.updateMembers(ctx('u0'), 'c1', ['u-new'], [], [])).rejects.toMatchObject({
      error: { code: status.RESOURCE_EXHAUSTED },
    });
  });

  it('requireMembership emits chat.isolation.denied for non-member (NFR-CHAT-100)', async () => {
    const conv = {
      _id: 'c1',
      type: 'group',
      scope: SCOPE,
      projectId: 'p1',
      seqCounter: 0,
    };
    const membersColl = {
      findOne: jest.fn(async () => null),
    };
    const convColl = {
      findOne: jest.fn(async ({ _id }: { _id: string }) => (_id === 'c1' ? conv : null)),
    };
    let captured: { type: string }[] = [];
    const capturingOutbox = {
      withOutbox: async (fn: (s?: unknown) => Promise<{ result: unknown; intents: unknown[] }>) => {
        const r = await fn();
        captured = r.intents as { type: string }[];
        return r.result;
      },
    } as never;
    const mongo = {
      members: jest.fn(async () => membersColl),
      conversations: jest.fn(async () => convColl),
      messages: jest.fn(),
    } as never;
    const svc = new ChatService(mongo, capturingOutbox, metrics);
    await expect(svc.getConversation(ctx('outsider'), 'c1')).rejects.toMatchObject({
      error: { code: status.PERMISSION_DENIED },
    });
    expect(captured.some((i) => i.type === 'chat.isolation.denied')).toBe(true);
  });

  it('transferOwnership on DM converts to group and archives DM (FR-CHAT-080)', async () => {
    const dm = {
      _id: 'dm1',
      type: 'dm',
      scope: SCOPE,
      projectId: 'p1',
      title: '',
      seqCounter: 3,
      lastMessage: null,
      lastMessageAt: 0,
      archivedAt: null,
      createdAt: 1,
      updatedAt: 1,
      createdBy: 'u1',
    };
    const members = [
      { conversationId: 'dm1', userId: 'u1', role: 'owner', leftAt: null },
      { conversationId: 'dm1', userId: 'u2', role: 'member', leftAt: null },
    ];
    const membersColl = {
      findOne: jest.fn(async (f: { userId?: string; conversationId?: string }) =>
        members.find(
          (m) => m.conversationId === f.conversationId && m.userId === f.userId && m.leftAt === null,
        ) ?? null,
      ),
      find: jest.fn(() => ({ toArray: async () => members })),
      insertMany: jest.fn(),
    };
    let archived = false;
    let archivedDmKey: string | undefined;
    let insertedGroup: { type?: string; title?: string } | null = null;
    const convColl = {
      findOne: jest.fn(async ({ _id }: { _id: string }) => (_id === 'dm1' ? dm : null)),
      updateOne: jest.fn(async (f: { _id: string }, u: { $set: { archivedAt?: number; dmKey?: string } }) => {
        if (f._id === 'dm1' && u.$set.archivedAt) {
          archived = true;
          archivedDmKey = u.$set.dmKey;
        }
      }),
      insertOne: jest.fn(async (doc: { type?: string; title?: string }) => {
        insertedGroup = doc;
      }),
    };
    const mongo = {
      members: jest.fn(async () => membersColl),
      conversations: jest.fn(async () => convColl),
      messages: jest.fn(),
    } as never;
    const capturingOutbox = {
      withOutbox: async (fn: (s?: unknown) => Promise<{ result: unknown; intents: unknown[] }>) =>
        (await fn()).result,
    } as never;
    const svc = new ChatService(mongo, capturingOutbox, metrics);
    const view = await svc.transferOwnership(ctx('mgr'), 'dm1', 'u3', true);
    expect(archived).toBe(true);
    expect(archivedDmKey).toMatch(/^archived:/);
    expect(insertedGroup?.type).toBe('group');
    expect(view.type).toBe('group');
    expect(membersColl.insertMany).toHaveBeenCalled();
  });

  it('transferOwnership on group stays owner-only even with canManage (no guard weaken)', async () => {
    const conv = {
      _id: 'g1',
      type: 'group',
      scope: SCOPE,
      projectId: 'p1',
      lastMessage: null,
      lastMessageAt: 0,
      archivedAt: null,
      createdAt: 1,
      updatedAt: 1,
    };
    const membersColl = {
      findOne: jest.fn(async (f: { userId?: string }) =>
        f.userId === 'admin'
          ? { conversationId: 'g1', userId: 'admin', role: 'admin', leftAt: null }
          : null,
      ),
    };
    const mongo = {
      members: jest.fn(async () => membersColl),
      conversations: jest.fn(async () => ({
        findOne: jest.fn(async () => conv),
      })),
      messages: jest.fn(),
    } as never;
    const svc = new ChatService(mongo, outbox, metrics);
    await expect(svc.transferOwnership(ctx('admin'), 'g1', 'u2', true)).rejects.toMatchObject({
      error: { code: status.PERMISSION_DENIED },
    });
  });

  it('sendMessage stores entityRefs parsed from text (FR-CHAT-440)', async () => {
    const conv = { _id: 'c1', scope: SCOPE, projectId: 'p1', seqCounter: 0, title: '' };
    let saved: { entityRefs?: { type: string; id: string }[] } = {};
    const messagesColl = {
      findOne: jest.fn(async () => null),
      insertOne: jest.fn(async (doc: { entityRefs?: { type: string; id: string }[] }) => {
        saved = doc;
      }),
    };
    const convColl = {
      findOne: jest.fn(async () => conv),
      findOneAndUpdate: jest.fn(async () => ({ ...conv, seqCounter: 1 })),
      updateOne: jest.fn(),
    };
    const membersColl = {
      findOne: jest.fn(async () => ({ userId: 'u1', leftAt: null })),
      find: jest.fn(() => ({ toArray: async () => [{ userId: 'u1', leftAt: null }] })),
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
    await svc.sendMessage(
      ctx('u1'),
      'c1',
      '[[entity:deal:d1|Сделка]]',
      'cm1',
      [],
      [],
      undefined,
      'user',
    );
    expect(saved.entityRefs).toEqual([{ type: 'deal', id: 'd1', label: 'Сделка' }]);
  });
});
