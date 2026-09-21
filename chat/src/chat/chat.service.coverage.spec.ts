import { status } from '@grpc/grpc-js';
import { ChatService } from './chat.service';
import type { ChatCtx } from './chat.types';

const SCOPE = { kind: 'project', scopeId: 'p1' };
const ctx = (userId: string, causation?: ChatCtx['causation']): ChatCtx =>
  ({ userId, scope: SCOPE, causation }) as unknown as ChatCtx;

const outboxPass = {
  withOutbox: async (fn: (s?: unknown) => Promise<{ result: unknown; intents?: unknown[] }>) =>
    (await fn()).result,
} as never;

const metrics = { recordChatMessageSent: jest.fn() } as never;

describe('ChatService coverage gaps', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('getConversation NOT_FOUND если беседа отсутствует', async () => {
    const mongo = {
      conversations: jest.fn(async () => ({ findOne: jest.fn(async () => null) })),
      members: jest.fn(),
    } as never;
    const svc = new ChatService(mongo, outboxPass, metrics);
    await expect(svc.getConversation(ctx('u1'), 'missing')).rejects.toMatchObject({
      error: { code: status.NOT_FOUND, message: 'Беседа не найдена' },
    });
  });

  it('getConversation возвращает view для участника', async () => {
    const conv = {
      _id: 'c1',
      type: 'group',
      scope: SCOPE,
      projectId: 'p1',
      title: 'Team',
      createdBy: 'u1',
      seqCounter: 0,
      createdAt: 1,
      updatedAt: 1,
    };
    const mongo = {
      conversations: jest.fn(async () => ({ findOne: jest.fn(async () => conv) })),
      members: jest.fn(async () => ({
        findOne: jest.fn(async () => ({ userId: 'u1', role: 'owner', leftAt: null, unreadCount: 0 })),
        find: jest.fn(() => ({ toArray: async () => [{ userId: 'u1', role: 'owner', leftAt: null }] })),
      })),
    } as never;
    const svc = new ChatService(mongo, outboxPass, metrics);
    const r = await svc.getConversation(ctx('u1'), 'c1');
    expect(r).toMatchObject({ id: 'c1', title: 'Team', myRole: 'owner' });
  });

  it('createConversation INVALID_ARGUMENT для dm без peer_user_id', async () => {
    const mongo = { conversations: jest.fn(), members: jest.fn() } as never;
    const svc = new ChatService(mongo, outboxPass, metrics);
    await expect(svc.createConversation(ctx('u1'), 'dm')).rejects.toMatchObject({
      error: { code: status.INVALID_ARGUMENT, message: 'dm требует peer_user_id' },
    });
  });

  it('createConversation RESOURCE_EXHAUSTED при превышении CHAT_MAX_MEMBERS', async () => {
    const prev = process.env.CHAT_MAX_MEMBERS;
    process.env.CHAT_MAX_MEMBERS = '2';
    jest.resetModules();
    const { ChatService: Svc } = await import('./chat.service');
    const mongo = { conversations: jest.fn(), members: jest.fn() } as never;
    const svc = new Svc(mongo, outboxPass, metrics);
    await expect(
      svc.createConversation(ctx('u1'), 'group', undefined, 'Big', ['u2', 'u3']),
    ).rejects.toMatchObject({
      error: { code: status.RESOURCE_EXHAUSTED, message: 'Превышен лимит участников беседы' },
    });
    jest.resetModules();
    if (prev === undefined) delete process.env.CHAT_MAX_MEMBERS;
    else process.env.CHAT_MAX_MEMBERS = prev;
  });

  it('createConversation DM race: duplicate key возвращает существующую беседу', async () => {
    const existing = {
      _id: 'c-dm',
      type: 'dm',
      scope: SCOPE,
      projectId: 'p1',
      dmKey: 'dm:p1:u1:u2',
      createdBy: 'u1',
      seqCounter: 0,
      createdAt: 1,
      updatedAt: 1,
    };
    let findCalls = 0;
    const convColl = {
      findOne: jest.fn(async () => {
        findCalls += 1;
        return findCalls === 1 ? null : existing;
      }),
      insertOne: jest.fn(async () => {
        const err = new Error('dup') as Error & { code?: number };
        err.code = 11000;
        throw err;
      }),
    };
    const membersColl = {
      insertMany: jest.fn(),
      findOne: jest.fn(async () => ({ userId: 'u1', role: 'owner', leftAt: null, unreadCount: 0 })),
      find: jest.fn(() => ({ toArray: async () => [{ userId: 'u1', role: 'owner', leftAt: null }] })),
    };
    const mongo = {
      conversations: jest.fn(async () => convColl),
      members: jest.fn(async () => membersColl),
    } as never;
    const svc = new ChatService(mongo, outboxPass, metrics);
    const r = await svc.createConversation(ctx('u1'), 'dm', 'u2');
    expect(r).toMatchObject({ id: 'c-dm' });
    expect(convColl.insertOne).toHaveBeenCalled();
  });

  it('updateMembers добавляет участника и эмитит chat.member.added', async () => {
    const conv = { _id: 'c1', scope: SCOPE, projectId: 'p1', type: 'group' };
    const membersColl = {
      findOne: jest.fn(async () => ({ userId: 'u1', role: 'owner', leftAt: null })),
      find: jest.fn(() => ({ toArray: async () => [{ userId: 'u1', leftAt: null }] })),
      updateOne: jest.fn(),
    };
    let intents: { type: string }[] = [];
    const capturingOutbox = {
      withOutbox: async (fn: (s?: unknown) => Promise<{ result: unknown; intents: unknown[] }>) => {
        const r = await fn();
        intents = r.intents as { type: string }[];
        return r.result;
      },
    } as never;
    const mongo = {
      conversations: jest.fn(async () => ({
        findOne: jest.fn(async () => conv),
      })),
      members: jest.fn(async () => membersColl),
    } as never;
    const svc = new ChatService(mongo, capturingOutbox, metrics);
    await svc.updateMembers(ctx('u1'), 'c1', ['u2'], [], []);
    expect(membersColl.updateOne).toHaveBeenCalled();
    expect(intents.map((i) => i.type)).toContain('chat.member.added');
  });

  it('updateMembers применяет role_changes', async () => {
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
    const svc = new ChatService(mongo, outboxPass, metrics);
    await svc.updateMembers(ctx('u1'), 'c1', [], [], [{ user_id: 'u2', role: 'admin' }]);
    expect(membersColl.updateOne).toHaveBeenCalledWith(
      { conversationId: 'c1', userId: 'u2' },
      { $set: { role: 'admin' } },
      {},
    );
  });

  it('transferOwnership INVALID_ARGUMENT без new_owner_user_id', async () => {
    const mongo = {
      conversations: jest.fn(async () => ({ findOne: jest.fn(async () => ({ _id: 'c1', scope: SCOPE, type: 'group' })) })),
      members: jest.fn(),
    } as never;
    const svc = new ChatService(mongo, outboxPass, metrics);
    await expect(svc.transferOwnership(ctx('u1'), 'c1', '  ')).rejects.toMatchObject({
      error: { code: status.INVALID_ARGUMENT, message: 'new_owner_user_id обязателен' },
    });
  });

  it('transferOwnership group: новый владелец не участник → INVALID_ARGUMENT', async () => {
    const conv = { _id: 'c1', scope: SCOPE, type: 'group', projectId: 'p1' };
    const membersColl = {
      findOne: jest.fn(async (q: { userId?: string }) => {
        if (q.userId === 'u1') return { userId: 'u1', role: 'owner', leftAt: null };
        return null;
      }),
    };
    const mongo = {
      conversations: jest.fn(async () => ({ findOne: jest.fn(async () => conv) })),
      members: jest.fn(async () => membersColl),
    } as never;
    const svc = new ChatService(mongo, outboxPass, metrics);
    await expect(svc.transferOwnership(ctx('u1'), 'c1', 'u9')).rejects.toMatchObject({
      error: { code: status.INVALID_ARGUMENT, message: 'Новый владелец не является участником' },
    });
  });

  it('transferOwnership group: передаёт владение участнику', async () => {
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
    const convColl = { findOne: jest.fn(async () => conv), updateOne: jest.fn() };
    const mongo = {
      conversations: jest.fn(async () => convColl),
      members: jest.fn(async () => membersColl),
    } as never;
    const svc = new ChatService(mongo, outboxPass, metrics);
    const r = await svc.transferOwnership(ctx('u1'), 'c1', 'u2');
    expect(membersColl.updateOne).toHaveBeenCalledWith(
      { conversationId: 'c1', userId: 'u2' },
      { $set: { role: 'owner' } },
      {},
    );
    expect(r).toMatchObject({ id: 'c1' });
  });

  it('archiveConversation архивирует беседу для owner/admin', async () => {
    const conv = {
      _id: 'c1',
      scope: SCOPE,
      projectId: 'p1',
      type: 'group',
      archivedAt: null as number | null,
      createdBy: 'u1',
      seqCounter: 0,
      createdAt: 1,
      updatedAt: 1,
    };
    const updateOne = jest.fn(async () => {
      conv.archivedAt = Date.now();
    });
    const mongo = {
      conversations: jest.fn(async () => ({
        findOne: jest.fn(async () => conv),
        updateOne,
      })),
      members: jest.fn(async () => ({
        findOne: jest.fn(async () => ({ userId: 'u1', role: 'owner', leftAt: null, unreadCount: 0 })),
        find: jest.fn(() => ({ toArray: async () => [{ userId: 'u1', role: 'owner', leftAt: null }] })),
      })),
    } as never;
    const svc = new ChatService(mongo, outboxPass, metrics);
    const r = await svc.archiveConversation(ctx('u1'), 'c1');
    expect(updateOne).toHaveBeenCalledWith(
      { _id: 'c1' },
      expect.objectContaining({ $set: expect.objectContaining({ archivedAt: expect.any(Number) }) }),
    );
    expect(r.archivedAt).toBeGreaterThan(0);
  });

  it('getMessages фильтрует по beforeSeq', async () => {
    const find = jest.fn(() => ({ sort: () => ({ limit: () => ({ toArray: async () => [] }) }) }));
    const mongo = {
      conversations: jest.fn(async () => ({ findOne: jest.fn(async () => ({ _id: 'c1', scope: SCOPE })) })),
      members: jest.fn(async () => ({
        findOne: jest.fn(async () => ({ userId: 'u1', leftAt: null })),
      })),
      messages: jest.fn(async () => ({ find })),
    } as never;
    const svc = new ChatService(mongo, outboxPass, metrics);
    await svc.getMessages(ctx('u1'), 'c1', 10, 20);
    expect(find).toHaveBeenCalledWith({ conversationId: 'c1', seq: { $lt: 10 } });
  });

  it('editMessage PERMISSION_DENIED для чужого сообщения', async () => {
    const msg = {
      _id: 'm1',
      conversationId: 'c1',
      senderId: 'u2',
      scope: SCOPE,
      text: 'hi',
      sentAt: Date.now(),
      deletedAt: null,
    };
    const mongo = {
      messages: jest.fn(async () => ({ findOne: jest.fn(async () => msg) })),
      members: jest.fn(async () => ({
        findOne: jest.fn(async () => ({ userId: 'u1', leftAt: null })),
      })),
      conversations: jest.fn(),
    } as never;
    const svc = new ChatService(mongo, outboxPass, metrics);
    await expect(svc.editMessage(ctx('u1'), 'm1', 'new')).rejects.toMatchObject({
      error: { code: status.PERMISSION_DENIED, message: 'Редактировать можно только своё сообщение' },
    });
  });

  it('editMessage FAILED_PRECONDITION при истёкшем окне редактирования', async () => {
    const prev = process.env.CHAT_EDIT_WINDOW_MS;
    process.env.CHAT_EDIT_WINDOW_MS = '1000';
    jest.resetModules();
    const { ChatService: Svc } = await import('./chat.service');
    const msg = {
      _id: 'm1',
      conversationId: 'c1',
      senderId: 'u1',
      scope: SCOPE,
      text: 'hi',
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
    const svc = new Svc(mongo, outboxPass, metrics);
    await expect(svc.editMessage(ctx('u1'), 'm1', 'new')).rejects.toMatchObject({
      error: { code: status.FAILED_PRECONDITION, message: 'Окно редактирования истекло' },
    });
    jest.resetModules();
    if (prev === undefined) delete process.env.CHAT_EDIT_WINDOW_MS;
    else process.env.CHAT_EDIT_WINDOW_MS = prev;
  });

  it('editMessage обновляет текст и эмитит chat.message.edited', async () => {
    const updated = {
      _id: 'm1',
      conversationId: 'c1',
      senderId: 'u1',
      scope: SCOPE,
      seq: 1,
      senderType: 'user',
      kind: 'text',
      text: 'new',
      attachments: [],
      mentionIds: [],
      clientMessageId: 'cid',
      sentAt: Date.now(),
      editedAt: Date.now(),
      createdAt: 1,
    };
    const msg = { ...updated, text: 'hi', editedAt: undefined };
    let intents: { type: string }[] = [];
    const capturingOutbox = {
      withOutbox: async (fn: (s?: unknown) => Promise<{ result: unknown; intents: unknown[] }>) => {
        const r = await fn();
        intents = r.intents as { type: string }[];
        return r.result;
      },
    } as never;
    const messagesColl = {
      findOne: jest
        .fn()
        .mockResolvedValueOnce(msg)
        .mockResolvedValueOnce(updated),
      updateOne: jest.fn(),
      find: jest.fn(() => ({ sort: () => ({ limit: () => ({ toArray: async () => [updated] }) }) })),
    };
    const mongo = {
      messages: jest.fn(async () => messagesColl),
      members: jest.fn(async () => ({
        findOne: jest.fn(async () => ({ userId: 'u1', leftAt: null })),
      })),
      conversations: jest.fn(async () => ({
        findOne: jest.fn(async () => ({ _id: 'c1', lastMessage: { id: 'other' } })),
        updateOne: jest.fn(),
      })),
    } as never;
    const svc = new ChatService(mongo, capturingOutbox, metrics);
    const r = await svc.editMessage(ctx('u1'), 'm1', 'new');
    expect(r.text).toBe('new');
    expect(messagesColl.updateOne).toHaveBeenCalled();
    expect(intents.map((i) => i.type)).toContain('chat.message.edited');
  });

  it('editMessage FAILED_PRECONDITION для удалённого сообщения', async () => {
    const msg = {
      _id: 'm1',
      conversationId: 'c1',
      senderId: 'u1',
      scope: SCOPE,
      text: 'hi',
      sentAt: Date.now(),
      deletedAt: Date.now(),
    };
    const mongo = {
      messages: jest.fn(async () => ({ findOne: jest.fn(async () => msg) })),
      members: jest.fn(async () => ({
        findOne: jest.fn(async () => ({ userId: 'u1', leftAt: null })),
      })),
      conversations: jest.fn(),
    } as never;
    const svc = new ChatService(mongo, outboxPass, metrics);
    await expect(svc.editMessage(ctx('u1'), 'm1', 'new')).rejects.toMatchObject({
      error: { code: status.FAILED_PRECONDITION, message: 'Нельзя редактировать удалённое сообщение' },
    });
  });

  it('editMessage INVALID_ARGUMENT при превышении лимита 8 КБ', async () => {
    const msg = {
      _id: 'm1',
      conversationId: 'c1',
      senderId: 'u1',
      scope: SCOPE,
      text: 'hi',
      sentAt: Date.now(),
      deletedAt: null,
    };
    const mongo = {
      messages: jest.fn(async () => ({ findOne: jest.fn(async () => msg) })),
      members: jest.fn(async () => ({
        findOne: jest.fn(async () => ({ userId: 'u1', leftAt: null })),
      })),
      conversations: jest.fn(),
    } as never;
    const svc = new ChatService(mongo, outboxPass, metrics);
    await expect(svc.editMessage(ctx('u1'), 'm1', 'x'.repeat(9000))).rejects.toMatchObject({
      error: { code: status.INVALID_ARGUMENT, message: 'Сообщение превышает лимит 8 КБ' },
    });
  });

  it('deleteMessage NOT_FOUND для сообщения вне scope', async () => {
    const msg = {
      _id: 'm1',
      conversationId: 'c1',
      senderId: 'u1',
      scope: { kind: 'project', scopeId: 'other' },
      text: 'hi',
    };
    const mongo = {
      messages: jest.fn(async () => ({ findOne: jest.fn(async () => msg) })),
      members: jest.fn(),
      conversations: jest.fn(),
    } as never;
    const svc = new ChatService(mongo, outboxPass, metrics);
    await expect(svc.deleteMessage(ctx('u1'), 'm1', false)).rejects.toMatchObject({
      error: { code: status.NOT_FOUND, message: 'Сообщение не найдено' },
    });
  });

  it('getUnreadCount scope=all группирует unread по projectId', async () => {
    const members = [
      { conversationId: 'c1', userId: 'u1', unreadCount: 2, leftAt: null },
      { conversationId: 'c2', userId: 'u1', unreadCount: 3, leftAt: null },
    ];
    const mongo = {
      members: jest.fn(async () => ({ find: jest.fn(() => ({ toArray: async () => members })) })),
      conversations: jest.fn(async () => ({
        find: jest.fn(() => ({
          toArray: async () => [
            { _id: 'c1', scope: SCOPE, projectId: 'p1' },
            { _id: 'c2', scope: SCOPE, projectId: 'p2' },
          ],
        })),
      })),
    } as never;
    const svc = new ChatService(mongo, outboxPass, metrics);
    await expect(svc.getUnreadCount(ctx('u1'), 'all')).resolves.toEqual({
      count: 5,
      byProject: expect.arrayContaining([
        { projectId: 'p1', count: 2 },
        { projectId: 'p2', count: 3 },
      ]),
    });
  });

  it('getUnreadCount scope=current возвращает сумму unread в текущем scope', async () => {
    const members = [{ conversationId: 'c1', userId: 'u1', unreadCount: 4, leftAt: null }];
    const mongo = {
      members: jest.fn(async () => ({ find: jest.fn(() => ({ toArray: async () => members })) })),
      conversations: jest.fn(async () => ({
        find: jest.fn(() => ({
          toArray: async () => [{ _id: 'c1', scope: SCOPE, projectId: 'p1' }],
        })),
      })),
    } as never;
    const svc = new ChatService(mongo, outboxPass, metrics);
    await expect(svc.getUnreadCount(ctx('u1'), 'current')).resolves.toEqual({ count: 4, byProject: [] });
  });

  it('listHierarchyChannels возвращает project_channel для overview ids', async () => {
    const convs = [
      {
        _id: 'ch1',
        type: 'project_channel',
        scope: { kind: 'project', scopeId: 'p1' },
        projectId: 'p1',
        title: 'General',
        createdBy: 'u1',
        lastMessageAt: 100,
        createdAt: 1,
        updatedAt: 1,
      },
    ];
    const mongo = {
      conversations: jest.fn(async () => ({
        find: jest.fn(() => ({ sort: () => ({ toArray: async () => convs }) })),
      })),
    } as never;
    const svc = new ChatService(mongo, outboxPass, metrics);
    const r = await svc.listHierarchyChannels(ctx('u1'), ['p1']);
    expect(r.conversations).toHaveLength(1);
    expect(r.conversations[0]).toMatchObject({ id: 'ch1', title: 'General', unreadCount: 0, myRole: '' });
  });

  it('getReadReceipts возвращает readBy при числе участников ниже порога', async () => {
    const prev = process.env.CHAT_RECEIPT_AGGREGATE_THRESHOLD;
    process.env.CHAT_RECEIPT_AGGREGATE_THRESHOLD = '500';
    jest.resetModules();
    const { ChatService: Svc } = await import('./chat.service');
    const membersColl = {
      find: jest.fn(() => ({
        toArray: async () => [
          { userId: 'u1', role: 'owner', joinedAt: 1, leftAt: null, lastReadSeq: 5 },
          { userId: 'u2', role: 'member', joinedAt: 1, leftAt: null, lastReadSeq: 2 },
        ],
      })),
    };
    const mongo = {
      conversations: jest.fn(async () => ({
        findOne: jest.fn(async () => ({ _id: 'c1', scope: SCOPE, projectId: 'p1' })),
      })),
      members: jest.fn(async () => ({
        findOne: jest.fn(async () => ({ userId: 'u1', leftAt: null, lastReadSeq: 0 })),
        ...membersColl,
      })),
    } as never;
    const svc = new Svc(mongo, outboxPass, metrics);
    const r = await svc.getReadReceipts(ctx('u1'), 'c1', 3);
    expect(r.readCount).toBe(1);
    expect(r.aggregateOnly).toBe(false);
    expect(r.readBy).toEqual([
      expect.objectContaining({ userId: 'u1', lastReadSeq: 5 }),
    ]);
    jest.resetModules();
    if (prev === undefined) delete process.env.CHAT_RECEIPT_AGGREGATE_THRESHOLD;
    else process.env.CHAT_RECEIPT_AGGREGATE_THRESHOLD = prev;
  });

  it('searchMessages возвращает пустой список для пустого query', async () => {
    const members = jest.fn();
    const mongo = { members, messages: jest.fn() } as never;
    const svc = new ChatService(mongo, outboxPass, metrics);
    await expect(svc.searchMessages(ctx('u1'), '   ', 10)).resolves.toEqual({ messages: [] });
    expect(members).not.toHaveBeenCalled();
  });

  it('deleteMessage PERMISSION_DENIED для чужого сообщения без chat:moderate', async () => {
    const msg = {
      _id: 'm1',
      conversationId: 'c1',
      senderId: 'u2',
      scope: SCOPE,
      text: 'hi',
      sentAt: Date.now(),
    };
    const mongo = {
      messages: jest.fn(async () => ({ findOne: jest.fn(async () => msg) })),
      members: jest.fn(async () => ({
        findOne: jest.fn(async () => ({ userId: 'u1', leftAt: null })),
      })),
      conversations: jest.fn(),
    } as never;
    const svc = new ChatService(mongo, outboxPass, metrics);
    await expect(svc.deleteMessage(ctx('u1'), 'm1', false)).rejects.toMatchObject({
      error: { code: status.PERMISSION_DENIED, message: 'Удалять чужое может только модератор' },
    });
  });

  it('searchMessages ищет по $text среди membership бесед', async () => {
    const toArray = jest.fn(async () => [
      {
        _id: 'm1',
        conversationId: 'c1',
        scope: SCOPE,
        seq: 1,
        senderId: 'u1',
        senderType: 'user',
        kind: 'text',
        text: 'hello world',
        attachments: [],
        mentionIds: [],
        clientMessageId: 'cid',
        sentAt: 1,
        createdAt: 1,
      },
    ]);
    const find = jest.fn(() => ({ limit: () => ({ toArray }) }));
    const mongo = {
      members: jest.fn(async () => ({
        find: jest.fn(() => ({ toArray: async () => [{ conversationId: 'c1', userId: 'u1', leftAt: null }] })),
      })),
      messages: jest.fn(async () => ({ find })),
    } as never;
    const svc = new ChatService(mongo, outboxPass, metrics);
    const r = await svc.searchMessages(ctx('u1'), 'hello', 10);
    expect(find).toHaveBeenCalledWith(
      expect.objectContaining({
        conversationId: { $in: ['c1'] },
        $text: { $search: 'hello' },
        'scope.kind': 'project',
        'scope.scopeId': 'p1',
      }),
    );
    expect(r.messages).toHaveLength(1);
    expect(r.messages[0].text).toBe('hello world');
  });
});
