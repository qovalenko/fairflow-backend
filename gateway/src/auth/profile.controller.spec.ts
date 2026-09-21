import { of } from 'rxjs';
import { grpcBffCall } from '../bff/grpc-bff-call';
import { ProfileController } from './profile.controller';

jest.mock('../bff/grpc-bff-call', () => ({
  grpcBffCall: jest.fn(),
}));

const mockedGrpcBffCall = jest.mocked(grpcBffCall);

describe('ProfileController', () => {
  const outboundMeta = { build: jest.fn(() => ({})) };
  const changePassword = jest.fn(() => of({ ok: true }));
  const listSessions = jest.fn(() =>
    of({
      sessions: [
        {
          id: 's1',
          device_label: 'Chrome',
          ip: '127.0.0.1',
          created_at: '2024-01-01',
          last_seen_at: '2024-01-02',
          is_current: true,
        },
      ],
    }),
  );
  const cancelMyEmailChange = jest.fn(() => of({ ok: true }));
  const sendTransactionalEmail = jest.fn(() => of({ status: 'sent' }));

  function make(): ProfileController {
    const authClient = {
      getService: jest.fn(() => ({ changePassword, listSessions, cancelMyEmailChange })),
    };
    const notificationClient = {
      getService: jest.fn(() => ({ sendTransactionalEmail })),
    };
    const ctrl = new ProfileController(
      authClient as never,
      notificationClient as never,
      outboundMeta as never,
    );
    ctrl.onModuleInit();
    return ctrl;
  }

  const req = {
    user: { userId: 'u1', sessionId: 's-current' },
    headers: {},
    ip: '10.0.0.1',
  };

  beforeEach(() => {
    jest.clearAllMocks();
    mockedGrpcBffCall.mockImplementation(async (obs) => {
      const { firstValueFrom } = await import('rxjs');
      return firstValueFrom(obs as never);
    });
  });

  it('changePassword forwards credentials and returns ok', async () => {
    const ctrl = make();
    await expect(
      ctrl.changePassword(req as never, { currentPassword: 'old', newPassword: 'new' }),
    ).resolves.toEqual({ ok: true });
    expect(changePassword).toHaveBeenCalledWith(
      {
        current_password: 'old',
        new_password: 'new',
        current_session_id: 's-current',
      },
      {},
    );
  });

  it('listSessions maps wire fields to REST shape', async () => {
    const ctrl = make();
    const res = await ctrl.listSessions(req as never);
    expect(res.sessions[0]).toMatchObject({
      id: 's1',
      deviceLabel: 'Chrome',
      ip: '127.0.0.1',
      isCurrent: true,
    });
  });

  it('cancelMyEmailChange clears pending email', async () => {
    const ctrl = make();
    await expect(ctrl.cancelMyEmailChange(req as never)).resolves.toEqual({ pendingEmail: null });
    expect(cancelMyEmailChange).toHaveBeenCalledWith({}, {});
  });
});
