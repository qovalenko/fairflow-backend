import { status } from '@grpc/grpc-js';
import { Metadata } from '@grpc/grpc-js';
import { GW_METADATA } from '@fairflow/shared';
import { ChatGrpcController } from './chat.grpc.controller';
import { ChatService } from './chat.service';

describe('ChatGrpcController', () => {
  const chat = {
    listConversations: jest.fn(),
    getConversation: jest.fn(),
    createConversation: jest.fn(),
    updateMembers: jest.fn(),
    transferOwnership: jest.fn(),
    archiveConversation: jest.fn(),
    sendMessage: jest.fn(),
    getMessages: jest.fn(),
    editMessage: jest.fn(),
    deleteMessage: jest.fn(),
    markRead: jest.fn(),
    markAllRead: jest.fn(),
    getUnreadCount: jest.fn(),
    getReadReceipts: jest.fn(),
    listHierarchyChannels: jest.fn(),
    searchMessages: jest.fn(),
    isConversationMember: jest.fn(),
  } as unknown as ChatService;

  const ctrl = new ChatGrpcController(chat);

  function meta(opts: {
    userId?: string;
    projectId?: string;
    orgId?: string;
    workspaceId?: string;
    role?: string;
    permissions?: string;
  } = {}): Metadata {
    const m = new Metadata();
    if (opts.userId !== undefined) m.set(GW_METADATA.USER_ID, opts.userId);
    if (opts.projectId) m.set(GW_METADATA.PROJECT_ID, opts.projectId);
    if (opts.orgId) m.set(GW_METADATA.ORGANIZATION_ID, opts.orgId);
    if (opts.workspaceId) m.set(GW_METADATA.WORKSPACE_ID, opts.workspaceId);
    if (opts.role) m.set(GW_METADATA.ROLES, opts.role);
    if (opts.permissions) m.set(GW_METADATA.PERMISSIONS, opts.permissions);
    return m;
  }

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('ctx UNAUTHENTICATED без x-user-id', async () => {
    await expect(ctrl.listConversations({}, meta({ projectId: 'p1', userId: '' }))).rejects.toMatchObject(
      { error: { code: status.UNAUTHENTICATED } },
    );
  });

  it('resolveScope INVALID_ARGUMENT без project/org/workspace', async () => {
    await expect(ctrl.listConversations({}, meta({ userId: 'u1' }))).rejects.toMatchObject({
      error: { code: status.INVALID_ARGUMENT },
    });
  });

  it('resolveScope org при отсутствии projectId', async () => {
    chat.listConversations = jest.fn(async () => ({ conversations: [] }));
    await ctrl.listConversations({}, meta({ userId: 'u1', orgId: 'o1' }));
    expect(chat.listConversations).toHaveBeenCalledWith(
      expect.objectContaining({ scope: { kind: 'org', scopeId: 'o1' } }),
      false,
      'current',
    );
  });

  it('listConversations передаёт scope_filter=all', async () => {
    chat.listConversations = jest.fn(async () => ({ conversations: [] }));
    await ctrl.listConversations({ scope_filter: 'all' }, meta({ userId: 'u1', projectId: 'p1' }));
    expect(chat.listConversations).toHaveBeenCalledWith(expect.anything(), false, 'all');
  });

  it('listConversations передаёт include_archived=true', async () => {
    chat.listConversations = jest.fn(async () => ({ conversations: [] }));
    await ctrl.listConversations({ include_archived: true }, meta({ userId: 'u1', projectId: 'p1' }));
    expect(chat.listConversations).toHaveBeenCalledWith(expect.anything(), true, 'current');
  });

  it('createConversation rejects project_channel without chat:manage (FR-CHAT-050)', async () => {
    await expect(
      ctrl.createConversation({ type: 'project_channel', title: 'General' }, meta({ userId: 'u1', role: 'member' })),
    ).rejects.toMatchObject({ error: { code: status.PERMISSION_DENIED } });
    expect(chat.createConversation).not.toHaveBeenCalled();
  });

  it('createConversation allows project_channel for owner', async () => {
    chat.createConversation = jest.fn(async () => ({ id: 'c1' }));
    await ctrl.createConversation(
      { type: 'project_channel', title: 'General' },
      meta({ userId: 'u1', role: 'owner', projectId: 'p1' }),
    );
    expect(chat.createConversation).toHaveBeenCalled();
  });

  it('createConversation group не требует chat:manage', async () => {
    chat.createConversation = jest.fn(async () => ({ id: 'g1' }));
    await ctrl.createConversation(
      { type: 'group', title: 'Team', member_user_ids: ['u2'] },
      meta({ userId: 'u1', role: 'member', projectId: 'p1' }),
    );
    expect(chat.createConversation).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'u1' }),
      'group',
      undefined,
      'Team',
      ['u2'],
    );
  });

  it('sendMessage маппит snake_case attachments в camelCase', async () => {
    (chat as unknown as { sendMessage: jest.Mock }).sendMessage = jest.fn(async () => ({ id: 'm1' }));
    await ctrl.sendMessage(
      {
        conversation_id: 'c1',
        text: 'hi',
        client_message_id: 'cid',
        attachments: [{ document_id: 'd1', version_id: 'v1', file_name: 'f.txt', mime: 'text/plain', size: 3 }],
        mention_ids: ['u2'],
        sender_type: 'integration',
      },
      meta({ userId: 'u1', projectId: 'p1' }),
    );
    expect(chat.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'u1' }),
      'c1',
      'hi',
      'cid',
      [expect.objectContaining({ documentId: 'd1', versionId: 'v1', fileName: 'f.txt' })],
      ['u2'],
      undefined,
      'integration',
    );
  });

  it('deleteMessage передаёт canModerate из permissions metadata', async () => {
    (chat as unknown as { deleteMessage: jest.Mock }).deleteMessage = jest.fn(async () => ({ id: 'm1' }));
    await ctrl.deleteMessage(
      { message_id: 'm1' },
      meta({ userId: 'u1', projectId: 'p1', permissions: 'chat:read, chat:moderate' }),
    );
    expect(chat.deleteMessage).toHaveBeenCalledWith(expect.anything(), 'm1', true);
  });

  it('deleteMessage canModerate=false без permission', async () => {
    (chat as unknown as { deleteMessage: jest.Mock }).deleteMessage = jest.fn(async () => ({ id: 'm1' }));
    await ctrl.deleteMessage({ message_id: 'm1' }, meta({ userId: 'u1', projectId: 'p1' }));
    expect(chat.deleteMessage).toHaveBeenCalledWith(expect.anything(), 'm1', false);
  });

  it('transferOwnership прокидывает canManage', async () => {
    chat.transferOwnership = jest.fn(async () => ({}));
    await ctrl.transferOwnership(
      { conversation_id: 'c1', new_owner_user_id: 'u2' },
      meta({ userId: 'u1', projectId: 'p1', role: 'owner' }),
    );
    expect(chat.transferOwnership).toHaveBeenCalledWith(expect.anything(), 'c1', 'u2', true);
  });

  it('isConversationMember возвращает snake_case is_member', async () => {
    chat.isConversationMember = jest.fn(async () => true);
    await expect(
      ctrl.isConversationMember({ conversation_id: 'c1' }, meta({ userId: 'u1', projectId: 'p1' })),
    ).resolves.toEqual({ is_member: true });
  });

  it('listHierarchyChannels всегда передаёт пустой overview (BOX deorg)', async () => {
    chat.listHierarchyChannels = jest.fn(async () => ({ conversations: [] }));
    await ctrl.listHierarchyChannels({ overview_project_ids: ['p9'] }, meta({ userId: 'u1', projectId: 'p1' }));
    expect(chat.listHierarchyChannels).toHaveBeenCalledWith(expect.anything(), []);
  });

  it('resolveScope workspace при отсутствии project/org', async () => {
    chat.listConversations = jest.fn(async () => ({ conversations: [] }));
    await ctrl.listConversations({}, meta({ userId: 'u1', workspaceId: 'ws1' }));
    expect(chat.listConversations).toHaveBeenCalledWith(
      expect.objectContaining({ scope: { kind: 'workspace', scopeId: 'ws1' } }),
      false,
      'current',
    );
  });

  it('ctx прокидывает causation из x-trace-id', async () => {
    const m = meta({ userId: 'u1', projectId: 'p1' });
    m.set(GW_METADATA.TRACE_ID, 'trace-abc');
    chat.getConversation = jest.fn(async () => ({ id: 'c1' }));
    await ctrl.getConversation({ id: 'c1' }, m);
    expect(chat.getConversation).toHaveBeenCalledWith(
      expect.objectContaining({ causation: { traceId: 'trace-abc' } }),
      'c1',
    );
  });

  it('getConversation делегирует в ChatService', async () => {
    chat.getConversation = jest.fn(async () => ({ id: 'c1' }));
    await ctrl.getConversation({ id: 'c1' }, meta({ userId: 'u1', projectId: 'p1' }));
    expect(chat.getConversation).toHaveBeenCalledWith(expect.anything(), 'c1');
  });

  it('updateMembers прокидывает add/remove/role_changes', async () => {
    chat.updateMembers = jest.fn(async () => ({ id: 'c1' }));
    await ctrl.updateMembers(
      {
        conversation_id: 'c1',
        add: ['u2'],
        remove: ['u3'],
        role_changes: [{ user_id: 'u4', role: 'admin' }],
      },
      meta({ userId: 'u1', projectId: 'p1' }),
    );
    expect(chat.updateMembers).toHaveBeenCalledWith(expect.anything(), 'c1', ['u2'], ['u3'], [
      { user_id: 'u4', role: 'admin' },
    ]);
  });

  it('archiveConversation делегирует в ChatService', async () => {
    chat.archiveConversation = jest.fn(async () => ({ id: 'c1' }));
    await ctrl.archiveConversation({ conversation_id: 'c1' }, meta({ userId: 'u1', projectId: 'p1' }));
    expect(chat.archiveConversation).toHaveBeenCalledWith(expect.anything(), 'c1');
  });

  it('getMessages прокидывает before_seq и limit', async () => {
    chat.getMessages = jest.fn(async () => ({ messages: [] }));
    await ctrl.getMessages({ conversation_id: 'c1', before_seq: 5, limit: 20 }, meta({ userId: 'u1', projectId: 'p1' }));
    expect(chat.getMessages).toHaveBeenCalledWith(expect.anything(), 'c1', 5, 20);
  });

  it('editMessage делегирует в ChatService', async () => {
    (chat as unknown as { editMessage: jest.Mock }).editMessage = jest.fn(async () => ({ id: 'm1' }));
    await ctrl.editMessage({ message_id: 'm1', text: 'new' }, meta({ userId: 'u1', projectId: 'p1' }));
    expect(chat.editMessage).toHaveBeenCalledWith(expect.anything(), 'm1', 'new');
  });

  it('markRead и markAllRead делегируют в ChatService', async () => {
    chat.markRead = jest.fn(async () => ({ unreadCount: 0, totalUnread: 0 }));
    chat.markAllRead = jest.fn(async () => ({ updated: 1, totalUnread: 0 }));
    await ctrl.markRead({ conversation_id: 'c1', upto_seq: 3 }, meta({ userId: 'u1', projectId: 'p1' }));
    await ctrl.markAllRead({}, meta({ userId: 'u1', projectId: 'p1' }));
    expect(chat.markRead).toHaveBeenCalledWith(expect.anything(), 'c1', 3);
    expect(chat.markAllRead).toHaveBeenCalledWith(expect.anything());
  });

  it('getUnreadCount передаёт scope_filter=all', async () => {
    chat.getUnreadCount = jest.fn(async () => ({ count: 0, byProject: [] }));
    await ctrl.getUnreadCount({ scope_filter: 'all' }, meta({ userId: 'u1', projectId: 'p1' }));
    expect(chat.getUnreadCount).toHaveBeenCalledWith(expect.anything(), 'all');
  });

  it('getReadReceipts прокидывает upto_seq', async () => {
    chat.getReadReceipts = jest.fn(async () => ({ readBy: [], readCount: 0, totalMembers: 1, aggregateOnly: false }));
    await ctrl.getReadReceipts(
      { conversation_id: 'c1', upto_seq: 7 },
      meta({ userId: 'u1', projectId: 'p1' }),
    );
    expect(chat.getReadReceipts).toHaveBeenCalledWith(expect.anything(), 'c1', 7);
  });

  it('searchMessages прокидывает query и limit', async () => {
    chat.searchMessages = jest.fn(async () => ({ messages: [] }));
    await ctrl.searchMessages({ query: 'hello', limit: 10 }, meta({ userId: 'u1', projectId: 'p1' }));
    expect(chat.searchMessages).toHaveBeenCalledWith(expect.anything(), 'hello', 10);
  });
});
