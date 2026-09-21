import { of, throwError } from 'rxjs';
import { grpcBffCall } from './grpc-bff-call';
import { ChatRealtimeAccessService } from './chat-realtime-access.service';

jest.mock('./grpc-bff-call', () => ({
  grpcBffCall: jest.fn(),
}));

const mockedGrpcBffCall = jest.mocked(grpcBffCall);

describe('ChatRealtimeAccessService', () => {
  const outboundMeta = { build: jest.fn(() => ({})) };
  const systemOrg = { resolveSystemOrgId: jest.fn().mockResolvedValue('org-1') };
  const listConversations = jest.fn(() => of({ conversations: [{ id: 'c1' }, { id: 'c2' }] }));
  const chatClient = { getService: jest.fn(() => ({ listConversations })) };

  function make(denyList?: { isAllowed: jest.Mock }): ChatRealtimeAccessService {
    const svc = new ChatRealtimeAccessService(
      chatClient as never,
      outboundMeta as never,
      systemOrg as never,
      denyList as never,
    );
    svc.onModuleInit();
    return svc;
  }

  beforeEach(() => {
    jest.clearAllMocks();
    mockedGrpcBffCall.mockImplementation(async (obs) => {
      const { firstValueFrom } = await import('rxjs');
      return firstValueFrom(obs as never);
    });
  });

  it('isSessionActive short-circuits true when deny-list is absent', async () => {
    const svc = make();
    await expect(svc.isSessionActive({ userId: 'u1', sessionId: 's1', headers: {} })).resolves.toBe(
      true,
    );
  });

  it('isSessionActive delegates to SessionDenyListService', async () => {
    const denyList = { isAllowed: jest.fn().mockResolvedValue(false) };
    const svc = make(denyList);
    await expect(svc.isSessionActive({ userId: 'u1', sessionId: 's1', headers: {} })).resolves.toBe(
      false,
    );
    expect(denyList.isAllowed).toHaveBeenCalledWith('u1', 's1', {});
  });

  it('memberConversationIds merges project and org scoped lists', async () => {
    const svc = make();
    const ids = await svc.memberConversationIds({
      userId: 'u1',
      sessionId: 's1',
      headers: {},
      projectId: 'p1',
    });
    expect(ids).toEqual(new Set(['c1', 'c2']));
    expect(listConversations).toHaveBeenCalledTimes(2);
  });

  it('throws when every scope query fails', async () => {
    listConversations.mockImplementation(() => throwError(() => new Error('down')));
    const svc = make();
    await expect(
      svc.memberConversationIds({
        userId: 'u1',
        sessionId: 's1',
        headers: {},
        projectId: 'p1',
      }),
    ).rejects.toThrow('chat ListConversations unavailable');
  });
});
