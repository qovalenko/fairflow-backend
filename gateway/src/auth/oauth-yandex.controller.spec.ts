import { ServiceUnavailableException } from '@nestjs/common';
import { of } from 'rxjs';
import { grpcBffCall } from '../bff/grpc-bff-call';
import { OauthYandexController } from './oauth-yandex.controller';

jest.mock('../bff/grpc-bff-call', () => ({
  grpcBffCall: jest.fn(),
}));

const mockedGrpcBffCall = jest.mocked(grpcBffCall);

describe('OauthYandexController', () => {
  const OLD_ENV = { ...process.env };
  const outboundMeta = { build: jest.fn(() => ({})) };
  const gatewayEvents = { authLogin: jest.fn() };
  const employeeGate = { isActiveEmployee: jest.fn().mockResolvedValue(true) };
  const oauthLogin = jest.fn(() => of({ access_token: 'tok', user: { id: 'u1' } }));
  const authClient = { getService: jest.fn(() => ({ oauthLogin })) };

  function make(): OauthYandexController {
    const ctrl = new OauthYandexController(
      authClient as never,
      outboundMeta as never,
      gatewayEvents as never,
      employeeGate as never,
    );
    ctrl.onModuleInit();
    return ctrl;
  }

  beforeEach(() => {
    process.env = {
      ...OLD_ENV,
      YANDEX_OAUTH_CLIENT_ID: 'cid',
      YANDEX_OAUTH_CLIENT_SECRET: 'sec',
      APP_PUBLIC_URL: 'https://spa.test',
    };
    jest.clearAllMocks();
    mockedGrpcBffCall.mockImplementation(async (obs) => {
      const { firstValueFrom } = await import('rxjs');
      return firstValueFrom(obs as never);
    });
    globalThis.fetch = jest.fn() as typeof fetch;
  });

  afterEach(() => {
    process.env = OLD_ENV;
  });

  it('start responds 503 when provider is not configured', () => {
    delete process.env.YANDEX_OAUTH_CLIENT_ID;
    const ctrl = make();
    const redirect = jest.fn();
    expect(() => ctrl.start(undefined, { redirect } as never)).toThrow(ServiceUnavailableException);
  });

  it('start redirects to Yandex authorize with CSRF state', () => {
    const ctrl = make();
    const redirect = jest.fn();
    ctrl.start('https://spa.test/home', { redirect } as never);
    expect(redirect).toHaveBeenCalledWith(
      expect.stringContaining('https://oauth.yandex.ru/authorize'),
      302,
    );
    const url = redirect.mock.calls[0][0] as string;
    expect(url).toContain('client_id=cid');
    expect(url).toContain('state=');
  });

  it('callback redirects to handoff error on invalid state', async () => {
    const ctrl = make();
    const redirect = jest.fn();
    await ctrl.callback(
      undefined,
      'missing-state',
      undefined,
      { ip: '1.1.1.1' } as never,
      {
        redirect,
      } as never,
    );
    expect(redirect).toHaveBeenCalledWith(
      expect.stringContaining('error=oauth_invalid_state'),
      302,
    );
  });

  it('callback completes happy path after token exchange', async () => {
    const ctrl = make();
    const redirect = jest.fn();
    const header = jest.fn();
    const startRedirect = jest.fn();
    ctrl.start(undefined, { redirect: startRedirect } as never);
    const startUrl = String(startRedirect.mock.calls[0]?.[0] ?? '');
    const state = startUrl.match(/state=([^&]+)/)?.[1] ?? '';

    jest
      .mocked(globalThis.fetch)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ access_token: 'yandex-tok' }),
      } as Awaited<ReturnType<typeof fetch>>)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          id: 'ext-1',
          default_email: 'user@test',
          real_name: 'User',
        }),
      } as Awaited<ReturnType<typeof fetch>>);

    await ctrl.callback(
      'code-1',
      state,
      undefined,
      { ip: '1.1.1.1', headers: {} } as never,
      {
        redirect,
        header,
      } as never,
    );

    expect(oauthLogin).toHaveBeenCalled();
    expect(redirect).toHaveBeenCalledWith(expect.stringContaining('access_token=tok'), 302);
  });
});
