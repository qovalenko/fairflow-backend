import { status } from '@grpc/grpc-js';
import { ChatService } from './chat.service';
import type { ChatCtx } from './chat.types';

const SCOPE = { kind: 'project', scopeId: 'p1' };
const ctx = (userId: string, causation?: ChatCtx['causation']): ChatCtx =>
  ({ userId, scope: SCOPE, causation }) as unknown as ChatCtx;

const metrics = { recordChatMessageSent: jest.fn() } as never;

describe('ChatService branch gaps', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('createConversation возвращает существующий активный DM по dmKey', async () => {
    const existing = {
      _id: 'c-dm',
      type: 'dm',
      scope: SCOPE,
      projectId: 'p1',
      dmKey: 'u1:u2:p1',
      createdBy: 'u1',
      seqCounter: 0,
      createdAt: 1,
      updatedAt: 1,
    };
    const convColl = {
      findOne: jest.fn(async () => existing),
      insertOne: jest.fn(),
    };
    const mongo = {
      conversations: jest.fn(async () => convColl),
      members: jest.fn(async () => ({
        findOne: jest.fn(async () => ({ userId: 'u1', role: 'owner', leftAt: null, unreadCount: 0 })),
        find: jest.fn(() => ({ toArray: async () => [{ userId: 'u1', role: 'owner', leftAt: null }] })),
      })),
    } as never;
    const outbox = {
      withOutbox: async (fn: (s?: unknown) => Promise<{ result: unknown }>) => (await fn()).result,
    } as never;
    const svc = new ChatService(mongo, outbox, metrics);
    const r = await svc.createConversation(ctx('u1'), 'dm', 'u2');
    expect(r).toMatchObject({ id: 'c-dm' });
    expect(convColl.insertOne).not.toHaveBeenCalled();
  });

  it('createConversation group создаёт беседу и эмитит chat.conversation.created', async () => {
    let intents: { type: string }[] = [];
    const capturingOutbox = {
      withOutbox: async (fn: (s?: unknown) => Promise<{ result: unknown; intents: unknown[] }>) => {
        const r = await fn();
        intents = r.intents as { type: string }[];
        return r.result;
      },
    } as never;
    const membersColl = {
      insertMany: jest.fn(),
      findOne: jest.fn(async () => ({ userId: 'u1', role: 'owner', leftAt: null, unreadCount: 0 })),
      find: jest.fn(() => ({ toArray: async () => [{ userId: 'u1', role: 'owner', leftAt: null }] })),
    };
    const convColl = {
      findOne: jest.fn(async () => null),
      insertOne: jest.fn(),
    };
    const mongo = {
      conversations: jest.fn(async () => convColl),
      members: jest.fn(async () => membersColl),
    } as never;
    const svc = new ChatService(mongo, capturingOutbox, metrics);
    const r = await svc.createConversation(ctx('u1'), 'group', undefined, 'Team', ['u2']);
    expect(r).toMatchObject({ title: 'Team', myRole: 'owner' });
    expect(convColl.insertOne).toHaveBeenCalled();
    expect(intents.map((i) => i.type)).toContain('chat.conversation.created');
  });

  it('transferOwnership group передаёт владение и понижает текущего owner до admin', async () => {
    const conv = {
      _id: 'c1',
      scope: SCOPE,
      type: 'group',
      projectId: 'p1',
      createdBy: 'u1',
      seqCounter: 0,
      createdAt: 1,
      updatedAt: 1,
    };
    const membersColl = {
      findOne: jest.fn(async (q: { userId?: string }) => {
        if (q.userId === 'u1') return { userId: 'u1', role: 'owner', leftAt: null, unreadCount: 0 };
        if (q.userId === 'u2') return { userId: 'u2', role: 'member', leftAt: null, unreadCount: 0 };
        return null;
      }),
      find: jest.fn(() => ({ toArray: async () => [{ userId: 'u1' }, { userId: 'u2' }] })),
      updateOne: jest.fn(),
    };
    const convColl = {
      findOne: jest.fn(async () => conv),
      updateOne: jest.fn(),
    };
    const outbox = {
      withOutbox: async (fn: (s?: unknown) => Promise<{ result: unknown }>) => {
        await fn({});
        return null;
      },
    } as never;
    const mongo = {
      conversations: jest.fn(async () => convColl),
      members: jest.fn(async () => membersColl),
    } as never;
    const svc = new ChatService(mongo, outbox, metrics);
    const r = await svc.transferOwnership(ctx('u1'), 'c1', 'u2');
    expect(membersColl.updateOne).toHaveBeenCalledWith(
      { conversationId: 'c1', userId: 'u2' },
      { $set: { role: 'owner' } },
      expect.anything(),
    );
    expect(membersColl.updateOne).toHaveBeenCalledWith(
      { conversationId: 'c1', userId: 'u1' },
      { $set: { role: 'admin' } },
      expect.anything(),
    );
    expect(convColl.updateOne).toHaveBeenCalled();
    expect(r).toMatchObject({ id: 'c1' });
  });

  it('transferOwnership DM: не-участник без canManage получает PERMISSION_DENIED', async () => {
    const dm = {
      _id: 'dm1',
      type: 'dm',
      scope: SCOPE,
      projectId: 'p1',
      dmKey: 'u1:u2:p1',
      createdBy: 'u1',
      seqCounter: 0,
      createdAt: 1,
      updatedAt: 1,
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
      conversations: jest.fn(async () => ({ findOne: jest.fn(async () => dm) })),
      members: jest.fn(async () => ({
        findOne: jest.fn(async () => null),
        find: jest.fn(),
        insertMany: jest.fn(),
      })),
    } as never;
    const svc = new ChatService(mongo, capturingOutbox, metrics);
    await expect(svc.transferOwnership(ctx('outsider'), 'dm1', 'u3', false)).rejects.toMatchObject({
      error: { code: status.PERMISSION_DENIED, message: 'Вы не участник беседы' },
    });
    expect(captured.some((i) => i.type === 'chat.isolation.denied')).toBe(true);
  });

  it('transferOwnership DM: участник не-owner без canManage получает PERMISSION_DENIED', async () => {
    const dm = {
      _id: 'dm1',
      type: 'dm',
      scope: SCOPE,
      projectId: 'p1',
      createdBy: 'u1',
      seqCounter: 0,
      createdAt: 1,
      updatedAt: 1,
    };
    const mongo = {
      conversations: jest.fn(async () => ({ findOne: jest.fn(async () => dm) })),
      members: jest.fn(async () => ({
        findOne: jest.fn(async () => ({ userId: 'u2', role: 'member', leftAt: null })),
        find: jest.fn(),
      })),
    } as never;
    const svc = new ChatService(mongo, { withOutbox: jest.fn() } as never, metrics);
    await expect(svc.transferOwnership(ctx('u2'), 'dm1', 'u3', false)).rejects.toMatchObject({
      error: { code: status.PERMISSION_DENIED, message: 'Передавать владение может только владелец' },
    });
  });

  it('transferOwnership DM: превышение MAX_MEMBERS при конвертации', async () => {
    const prev = process.env.CHAT_MAX_MEMBERS;
    process.env.CHAT_MAX_MEMBERS = '2';
    jest.resetModules();
    const { ChatService: Svc } = await import('./chat.service');
    const dm = {
      _id: 'dm1',
      type: 'dm',
      scope: SCOPE,
      projectId: 'p1',
      createdBy: 'u1',
      seqCounter: 0,
      createdAt: 1,
      updatedAt: 1,
    };
    const members = [
      { conversationId: 'dm1', userId: 'u1', role: 'owner', leftAt: null },
      { conversationId: 'dm1', userId: 'u2', role: 'member', leftAt: null },
    ];
    const mongo = {
      conversations: jest.fn(async () => ({ findOne: jest.fn(async () => dm) })),
      members: jest.fn(async () => ({
        findOne: jest.fn(async (q: { userId?: string }) =>
          members.find((m) => m.userId === q.userId) ?? null,
        ),
        find: jest.fn(() => ({ toArray: async () => members })),
      })),
    } as never;
    const svc = new Svc(mongo, { withOutbox: jest.fn() } as never, metrics);
    await expect(svc.transferOwnership(ctx('u1'), 'dm1', 'u3', false)).rejects.toMatchObject({
      error: { code: status.RESOURCE_EXHAUSTED },
    });
    jest.resetModules();
    if (prev === undefined) delete process.env.CHAT_MAX_MEMBERS;
    else process.env.CHAT_MAX_MEMBERS = prev;
  });

  it('updateMembers применяет role_changes через поле userId', async () => {
    const conv = { _id: 'c1', scope: SCOPE, projectId: 'p1', type: 'group' };
    const membersColl = {
      findOne: jest.fn(async () => ({ userId: 'u1', role: 'owner', leftAt: null })),
      find: jest.fn(() => ({ toArray: async () => [{ userId: 'u1', leftAt: null }] })),
      updateOne: jest.fn(),
    };
    const mongo = {
      conversations: jest.fn(async () => ({ findOne: jest.fn(async () => conv) })),
      members: jest.fn(async () => membersColl),
    } as never;
    const outbox = {
      withOutbox: async (fn: (s?: unknown) => Promise<{ result: unknown }>) => (await fn()).result,
    } as never;
    const svc = new ChatService(mongo, outbox, metrics);
    await svc.updateMembers(ctx('u1'), 'c1', [], [], [{ userId: 'u2', role: 'admin' }]);
    expect(membersColl.updateOne).toHaveBeenCalledWith(
      { conversationId: 'c1', userId: 'u2' },
      { $set: { role: 'admin' } },
      expect.anything(),
    );
  });

  it('sendMessage принимает сообщение только с вложениями', async () => {
    const conv = { _id: 'c1', scope: SCOPE, projectId: 'p1', seqCounter: 0, title: '' };
    const attachments = [{ documentId: 'd1', versionId: 'v1', fileName: 'f.txt', mime: 'text/plain', size: 3 }];
    const messagesColl = {
      findOne: jest.fn(async () => null),
      insertOne: jest.fn(),
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
    const outbox = {
      withOutbox: async (fn: (s?: unknown) => Promise<{ result: unknown }>) => (await fn()).result,
    } as never;
    const mongo = {
      conversations: jest.fn(async () => convColl),
      members: jest.fn(async () => membersColl),
      messages: jest.fn(async () => messagesColl),
    } as never;
    const svc = new ChatService(mongo, outbox, metrics);
    const r = await svc.sendMessage(ctx('u1'), 'c1', '   ', 'cm1', attachments, [], undefined, 'user');
    expect(r.attachments).toEqual(attachments);
    expect(messagesColl.insertOne).toHaveBeenCalled();
  });

  it('sendMessage INVALID_ARGUMENT при превышении лимита 8 КБ', async () => {
    const conv = { _id: 'c1', scope: SCOPE, projectId: 'p1', seqCounter: 0 };
    const mongo = {
      conversations: jest.fn(async () => ({ findOne: jest.fn(async () => conv) })),
      members: jest.fn(async () => ({
        findOne: jest.fn(async () => ({ userId: 'u1', leftAt: null })),
        find: jest.fn(),
      })),
      messages: jest.fn(async () => ({ findOne: jest.fn(async () => null) })),
    } as never;
    const svc = new ChatService(mongo, { withOutbox: jest.fn() } as never, metrics);
    await expect(
      svc.sendMessage(ctx('u1'), 'c1', 'x'.repeat(9000), 'cm1', [], [], undefined, 'user'),
    ).rejects.toMatchObject({
      error: { code: status.INVALID_ARGUMENT, message: 'Сообщение превышает лимит 8 КБ' },
    });
  });

  it('sendMessage пробрасывает 11000 если дубликат не найден после отката seq', async () => {
    const conv = { _id: 'c1', scope: SCOPE, projectId: 'p1', seqCounter: 4 };
    let lookupCount = 0;
    const messagesColl = {
      findOne: jest.fn(async () => {
        lookupCount += 1;
        return null;
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
    const mongo = {
      conversations: jest.fn(async () => convColl),
      members: jest.fn(async () => ({
        findOne: jest.fn(async () => ({ userId: 'u1', leftAt: null })),
        find: jest.fn(),
      })),
      messages: jest.fn(async () => messagesColl),
    } as never;
    const outbox = {
      withOutbox: async (fn: (s?: unknown) => Promise<{ result: unknown }>) => (await fn()).result,
    } as never;
    const svc = new ChatService(mongo, outbox, metrics);
    await expect(
      svc.sendMessage(ctx('u1'), 'c1', 'hi', 'cm1', [], [], undefined, 'user'),
    ).rejects.toThrow('dup');
    expect(lookupCount).toBeGreaterThanOrEqual(2);
  });

  it('deleteMessage обновляет lastMessage при удалении последнего сообщения', async () => {
    const msg = {
      _id: 'm1',
      conversationId: 'c1',
      senderId: 'u1',
      scope: SCOPE,
      projectId: 'p1',
      text: 'last',
      sentAt: Date.now(),
      deletedAt: null,
      seq: 1,
    };
    const previous = {
      _id: 'm0',
      conversationId: 'c1',
      senderId: 'u1',
      text: 'prev',
      sentAt: Date.now() - 1000,
      deletedAt: null,
      seq: 0,
      kind: 'text',
    };
    const messagesColl = {
      findOne: jest
        .fn()
        .mockResolvedValueOnce(msg)
        .mockResolvedValueOnce({ ...msg, text: '', deletedAt: Date.now(), kind: 'system' }),
      updateOne: jest.fn(),
      find: jest.fn(() => ({
        sort: () => ({
          limit: () => ({ toArray: async () => [previous] }),
        }),
      })),
    };
    const convColl = {
      findOne: jest.fn(async () => ({
        _id: 'c1',
        scope: SCOPE,
        lastMessage: { id: 'm1', text: 'last', senderId: 'u1', sentAt: msg.sentAt, kind: 'text' },
      })),
      updateOne: jest.fn(),
    };
    const outbox = {
      withOutbox: async (fn: (s?: unknown) => Promise<{ result: unknown }>) => (await fn()).result,
    } as never;
    const mongo = {
      messages: jest.fn(async () => messagesColl),
      members: jest.fn(async () => ({
        findOne: jest.fn(async () => ({ userId: 'u1', leftAt: null })),
      })),
      conversations: jest.fn(async () => convColl),
    } as never;
    const svc = new ChatService(mongo, outbox, metrics);
    await svc.deleteMessage(ctx('u1'), 'm1', false);
    expect(convColl.updateOne).toHaveBeenCalledWith(
      { _id: 'c1' },
      expect.objectContaining({
        $set: expect.objectContaining({
          lastMessage: expect.objectContaining({ id: 'm0', text: 'prev' }),
        }),
      }),
      expect.anything(),
    );
  });

  it('editMessage NOT_FOUND для отсутствующего сообщения', async () => {
    const mongo = {
      messages: jest.fn(async () => ({ findOne: jest.fn(async () => null) })),
      members: jest.fn(),
      conversations: jest.fn(),
    } as never;
    const svc = new ChatService(mongo, { withOutbox: jest.fn() } as never, metrics);
    await expect(svc.editMessage(ctx('u1'), 'missing', 'new')).rejects.toMatchObject({
      error: { code: status.NOT_FOUND, message: 'Сообщение не найдено' },
    });
  });

  it('deleteMessage NOT_FOUND для отсутствующего сообщения', async () => {
    const mongo = {
      messages: jest.fn(async () => ({ findOne: jest.fn(async () => null) })),
      members: jest.fn(),
      conversations: jest.fn(),
    } as never;
    const svc = new ChatService(mongo, { withOutbox: jest.fn() } as never, metrics);
    await expect(svc.deleteMessage(ctx('u1'), 'missing', false)).rejects.toMatchObject({
      error: { code: status.NOT_FOUND, message: 'Сообщение не найдено' },
    });
  });

  it('deleteMessage FAILED_PRECONDITION для автора после окна редактирования', async () => {
    const prev = process.env.CHAT_EDIT_WINDOW_MS;
    process.env.CHAT_EDIT_WINDOW_MS = '1000';
    jest.resetModules();
    const { ChatService: Svc } = await import('./chat.service');
    const msg = {
      _id: 'm1',
      conversationId: 'c1',
      senderId: 'u1',
      scope: SCOPE,
      text: 'old',
      sentAt: Date.now() - 5_000,
      deletedAt: null,
    };
    const mongo = {
      messages: jest.fn(async () => ({ findOne: jest.fn(async () => msg) })),
      members: jest.fn(async () => ({
        findOne: jest.fn(async () => ({ userId: 'u1', leftAt: null })),
      })),
      conversations: jest.fn(),
    } as never;
    const svc = new Svc(mongo, { withOutbox: jest.fn() } as never, metrics);
    await expect(svc.deleteMessage(ctx('u1'), 'm1', false)).rejects.toMatchObject({
      error: { code: status.FAILED_PRECONDITION, message: 'Окно редактирования истекло' },
    });
    jest.resetModules();
    if (prev === undefined) delete process.env.CHAT_EDIT_WINDOW_MS;
    else process.env.CHAT_EDIT_WINDOW_MS = prev;
  });

  it('listHierarchyChannels возвращает пустой список без overview ids', async () => {
    const conversations = jest.fn();
    const mongo = { conversations } as never;
    const svc = new ChatService(mongo, { withOutbox: jest.fn() } as never, metrics);
    await expect(svc.listHierarchyChannels(ctx('u1'), [])).resolves.toEqual({ conversations: [] });
    expect(conversations).not.toHaveBeenCalled();
  });

  it('searchMessages возвращает [] если у пользователя нет membership', async () => {
    const find = jest.fn();
    const mongo = {
      members: jest.fn(async () => ({
        find: jest.fn(() => ({ toArray: async () => [] })),
      })),
      messages: jest.fn(async () => ({ find })),
    } as never;
    const svc = new ChatService(mongo, { withOutbox: jest.fn() } as never, metrics);
    await expect(svc.searchMessages(ctx('u1'), 'hello', 10)).resolves.toEqual({ messages: [] });
    expect(find).not.toHaveBeenCalled();
  });

  it('emitIsolationDenied fail-soft: outbox outage не блокирует deny', async () => {
    const conv = { _id: 'c1', scope: SCOPE, projectId: 'p1', type: 'group' };
    const failingOutbox = {
      withOutbox: jest.fn(async () => {
        throw new Error('outbox down');
      }),
    } as never;
    const mongo = {
      conversations: jest.fn(async () => ({ findOne: jest.fn(async () => conv) })),
      members: jest.fn(async () => ({
        findOne: jest.fn(async () => null),
      })),
    } as never;
    const svc = new ChatService(mongo, failingOutbox, metrics);
    await expect(svc.getConversation(ctx('outsider'), 'c1')).rejects.toMatchObject({
      error: { code: status.PERMISSION_DENIED },
    });
  });
});
