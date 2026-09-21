import { of } from 'rxjs';

import { AuthController } from './auth.controller';
import { grpcBffCall } from '../bff/grpc-bff-call';

jest.mock('../bff/grpc-bff-call', () => ({
  grpcBffCall: jest.fn(),
}));

const mockedGrpcBffCall = jest.mocked(grpcBffCall);

/**
 * Verification: POST /v1/auth/forgot-password is a real end-to-end chain
 * (auth RequestPasswordReset → notification SendTransactionalEmail), not a stub.
 */
describe('AuthController.forgotPassword (POST /v1/auth/forgot-password)', () => {
  const PUBLIC_URL = 'https://app.example.test';
  const RESET_TOKEN = 'reset.jwt.token';

  function makeController() {
    const requestPasswordReset = jest.fn(() =>
      of({
        found: true,
        reset_token: RESET_TOKEN,
        email: 'user@example.com',
        name: 'User',
      }),
    );
    const sendTransactionalEmail = jest.fn(() => of({ status: 'sent', message_id: 'm1' }));

    const ctrl = Object.create(AuthController.prototype) as AuthController;
    const wire = ctrl as unknown as Record<string, unknown>;
    wire.authGrpc = { requestPasswordReset };
    wire.notificationGrpc = { sendTransactionalEmail };
    wire.outboundMeta = { build: jest.fn(() => ({})) };
    return { ctrl, requestPasswordReset, sendTransactionalEmail };
  }

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.APP_PUBLIC_URL = PUBLIC_URL;
    mockedGrpcBffCall.mockImplementation(async (obs) => {
      const { firstValueFrom } = await import('rxjs');
      return firstValueFrom(obs as never);
    });
  });

  it('calls auth RequestPasswordReset then notification SendTransactionalEmail', async () => {
    const { ctrl, requestPasswordReset, sendTransactionalEmail } = makeController();

    const res = await ctrl.forgotPassword({ email: 'User@Example.com' }, {
      ip: '127.0.0.1',
      headers: {},
    } as never);

    expect(res).toEqual({ ok: true });
    expect(requestPasswordReset).toHaveBeenCalledWith(
      { email: 'user@example.com' },
      expect.anything(),
    );
    expect(sendTransactionalEmail).toHaveBeenCalledWith(
      {
        to: 'user@example.com',
        kind: 'password_reset',
        action_url: `${PUBLIC_URL}/auth/reset-password/${RESET_TOKEN}`,
        user_name: 'User',
      },
      expect.anything(),
    );
  });

  it('returns generic ok without emailing when the account is unknown', async () => {
    const { ctrl, requestPasswordReset, sendTransactionalEmail } = makeController();
    requestPasswordReset.mockReturnValue(
      of({ found: false, reset_token: '', email: '', name: '' }),
    );

    const res = await ctrl.forgotPassword({ email: 'nobody@example.com' }, {
      ip: '127.0.0.2',
      headers: {},
    } as never);

    expect(res).toEqual({ ok: true });
    expect(sendTransactionalEmail).not.toHaveBeenCalled();
  });
});
