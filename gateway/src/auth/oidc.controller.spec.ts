import { NotFoundException } from '@nestjs/common';
import { of } from 'rxjs';
import { grpcBffCall } from '../bff/grpc-bff-call';
import { OidcBffController } from './oidc.controller';

jest.mock('../bff/grpc-bff-call', () => ({
  grpcBffCall: jest.fn(),
}));

const mockedGrpcBffCall = jest.mocked(grpcBffCall);

describe('OidcBffController', () => {
  const outboundMeta = { build: jest.fn(() => ({})) };
  const gatewayEvents = { authLogin: jest.fn() };
  const employeeGate = { isActiveEmployee: jest.fn().mockResolvedValue(true) };
  const oidc = {
    resolveEndpoints: jest.fn(),
    begin: jest.fn(),
    consumeState: jest.fn(),
    exchangeCode: jest.fn(),
    verifyIdToken: jest.fn(),
  };
  const listProviders = jest.fn(() =>
    of({ providers: [{ id: 'p1', name: 'Keycloak', issuer: 'https://idp' }] }),
  );
  const getProviderConfig = jest.fn(() =>
    of({ id: 'p1', name: 'Keycloak', issuer: 'https://idp', trust_email: true }),
  );
  const oidcLogin = jest.fn(() => of({ access_token: 'tok', user: { id: 'u1' } }));
  const authClient = {
    getService: jest.fn(() => ({ listProviders, getProviderConfig, oidcLogin })),
  };

  function make(): OidcBffController {
    const ctrl = new OidcBffController(
      authClient as never,
      outboundMeta as never,
      oidc as never,
      gatewayEvents as never,
      employeeGate as never,
    );
    ctrl.onModuleInit();
    return ctrl;
  }

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.APP_PUBLIC_URL = 'https://spa.test';
    mockedGrpcBffCall.mockImplementation(async (obs) => {
      const { firstValueFrom } = await import('rxjs');
      return firstValueFrom(obs as never);
    });
  });

  it('providers returns public projection without secrets', async () => {
    const ctrl = make();
    await expect(ctrl.providers({ headers: {} } as never)).resolves.toEqual({
      providers: [{ id: 'p1', name: 'Keycloak', issuer: 'https://idp' }],
    });
  });

  it('start throws NotFound for unknown provider', async () => {
    mockedGrpcBffCall.mockRejectedValueOnce(new Error('missing'));
    const ctrl = make();
    await expect(
      ctrl.start('missing', undefined, { headers: {} } as never, { redirect: jest.fn() } as never),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('start redirects to authorize URL on success', async () => {
    oidc.resolveEndpoints.mockResolvedValue({ authorization_endpoint: 'https://idp/auth' });
    oidc.begin.mockReturnValue({ authorizeUrl: 'https://idp/auth?state=x' });
    const ctrl = make();
    const redirect = jest.fn();
    await ctrl.start('p1', 'https://spa.test', { headers: {} } as never, { redirect } as never);
    expect(redirect).toHaveBeenCalledWith('https://idp/auth?state=x', 302);
  });

  it('callback redirects on state mismatch', async () => {
    oidc.consumeState.mockReturnValue(undefined);
    const ctrl = make();
    const redirect = jest.fn();
    await ctrl.callback(
      'code',
      'bad',
      undefined,
      { ip: '1.1.1.1', headers: {} } as never,
      {
        redirect,
      } as never,
    );
    expect(redirect).toHaveBeenCalledWith(
      expect.stringContaining('error=oidc_state_mismatch'),
      302,
    );
  });
});
