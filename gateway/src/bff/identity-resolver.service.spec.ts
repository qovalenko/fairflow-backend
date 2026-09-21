import { of, throwError } from 'rxjs';
import { grpcBffCall } from './grpc-bff-call';
import { IdentityResolverService } from './identity-resolver.service';

jest.mock('./grpc-bff-call', () => ({
  grpcBffCall: jest.fn(),
}));

const mockedGrpcBffCall = jest.mocked(grpcBffCall);

describe('IdentityResolverService', () => {
  const req = { headers: {}, user: { userId: 'viewer-1' } } as never;
  const outboundMeta = { build: jest.fn(() => ({ md: true })) };

  function make(resolveUsers: unknown) {
    const directory = { resolveUsers: jest.fn(() => resolveUsers) };
    const authClient = { getService: jest.fn(() => directory) };
    const svc = new IdentityResolverService(authClient as never, outboundMeta as never);
    svc.onModuleInit();
    return { svc, directory };
  }

  beforeEach(() => {
    jest.clearAllMocks();
    mockedGrpcBffCall.mockImplementation(async (obs) => {
      const { firstValueFrom } = await import('rxjs');
      return firstValueFrom(obs as never);
    });
  });

  it('returns an empty map for no ids', async () => {
    const { svc, directory } = make(of({ users: [] }));
    await expect(svc.resolve(req, [])).resolves.toEqual(new Map());
    expect(directory.resolveUsers).not.toHaveBeenCalled();
  });

  it('resolves profiles and deduplicates ids', async () => {
    const { svc, directory } = make(
      of({
        users: [
          { id: 'u-1', name: 'Alice', email: 'a@t.test', avatar_url: 'av-1' },
          { id: 'u-2', login: 'bob', email: 'b@t.test' },
        ],
      }),
    );

    const profiles = await svc.resolve(req, ['u-1', 'u-1', 'u-2', null, '']);

    expect(directory.resolveUsers).toHaveBeenCalledWith({ ids: ['u-1', 'u-2'] }, { md: true });
    expect(profiles.get('u-1')).toEqual({
      name: 'Alice',
      email: 'a@t.test',
      avatarUrl: 'av-1',
    });
    expect(profiles.get('u-2')).toEqual({
      name: 'bob',
      email: 'b@t.test',
      avatarUrl: '',
    });
  });

  it('uses cached profiles within TTL without a second RPC', async () => {
    const { svc, directory } = make(
      of({ users: [{ id: 'u-1', name: 'Alice', email: 'a@t.test' }] }),
    );

    await svc.resolve(req, ['u-1']);
    await svc.resolve(req, ['u-1']);

    expect(directory.resolveUsers).toHaveBeenCalledTimes(1);
  });

  it('fail-soft when auth is unavailable — unresolved ids stay out of the map', async () => {
    const { svc } = make(throwError(() => new Error('auth down')));

    await expect(svc.resolve(req, ['u-missing'])).resolves.toEqual(new Map());
  });

  it('resolveNames keeps ids that auth resolves without a display name', async () => {
    const { svc } = make(
      of({
        users: [
          { id: 'u-1', name: 'Alice' },
          { id: 'u-2', name: '' },
        ],
      }),
    );

    const names = await svc.resolveNames(req, ['u-1', 'u-2']);
    expect(names.get('u-1')).toBe('Alice');
    expect(names.get('u-2')).toBe('u-2');
  });
});
