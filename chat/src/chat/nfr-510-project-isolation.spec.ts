import { ChatService } from './chat.service';

/** NFR-510 — project isolation: listConversations scopes by current project scope. */
describe('ChatService project isolation (NFR-510)', () => {
  it('listConversations ANDs membership with scope.scopeId (project boundary)', async () => {
    const findCalls: Record<string, unknown>[] = [];
    const mongo = {
      members: async () => ({
        find: () => ({
          toArray: async () => [{ conversationId: 'c1' }],
        }),
      }),
      conversations: async () => ({
        find: (filter: Record<string, unknown>) => {
          findCalls.push(filter);
          return { sort: () => ({ toArray: async () => [] }) };
        },
      }),
    };
    const svc = new ChatService(mongo as never, {} as never, {} as never);
    await svc.listConversations(
      { userId: 'u1', scope: { kind: 'project', scopeId: 'proj-a' } },
      false,
      'current',
    );
    expect(findCalls[0]).toMatchObject({
      'scope.kind': 'project',
      'scope.scopeId': 'proj-a',
    });
  });
});
