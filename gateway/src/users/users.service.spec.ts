import { of } from 'rxjs';
import { grpcBffCall } from '../bff/grpc-bff-call';
import { UsersService } from '../users/users.service';

jest.mock('../bff/grpc-bff-call', () => ({
  grpcBffCall: jest.fn(),
}));

const mockedGrpcBffCall = jest.mocked(grpcBffCall);

describe('UsersService.findMany', () => {
  const outboundMeta = { build: jest.fn(() => ({})) };
  const listUsers = jest.fn(() =>
    of({
      list: [
        {
          id: 'u1',
          login: 'alice',
          email: 'a@test',
          name: 'Alice',
          is_active: true,
          created_at: '2024-01-01T00:00:00.000Z',
        },
      ],
      total: 1,
    }),
  );
  const authClient = { getService: jest.fn(() => ({ listUsers })) };

  function make(): UsersService {
    const svc = new UsersService(authClient as never, outboundMeta as never);
    svc.onModuleInit();
    return svc;
  }

  beforeEach(() => {
    jest.clearAllMocks();
    mockedGrpcBffCall.mockImplementation(async (obs: never) => {
      const { firstValueFrom } = await import('rxjs');
      return firstValueFrom(obs as never);
    });
  });

  it('maps gRPC users into REST shape and clamps take to 100', async () => {
    const svc = make();
    const req = { headers: {}, user: { userId: 'admin' } };
    const res = await svc.findMany(req as never, {
      skip: 5,
      take: 500,
      login: 'ali',
      isActive: true,
    });
    expect(listUsers).toHaveBeenCalledWith(
      { skip: 5, take: 100, login_filter: 'ali', is_active: true },
      {},
    );
    expect(res.total).toBe(1);
    expect(res.list[0]).toMatchObject({
      id: 'u1',
      login: 'alice',
      email: 'a@test',
      name: 'Alice',
      isActive: true,
    });
  });

  it('omits is_active filter when not requested', async () => {
    const svc = make();
    await svc.findMany({ headers: {} } as never, { skip: 0, take: 10 });
    expect(listUsers).toHaveBeenCalledWith({ skip: 0, take: 10, login_filter: '' }, {});
  });
});
