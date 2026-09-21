import { of } from 'rxjs';
import { grpcBffCall } from './grpc-bff-call';
import { SystemAuthBffController } from './system-auth-bff.controller';

jest.mock('./grpc-bff-call', () => ({
  grpcBffCall: jest.fn(),
}));

const mockedGrpcBffCall = jest.mocked(grpcBffCall);

describe('SystemAuthBffController', () => {
  const outboundMeta = { build: jest.fn(() => ({})) };
  const listServiceApiKeys = jest.fn(() =>
    of({
      keys: [
        {
          id: 'k1',
          name: 'gateway',
          key_prefix: 'ak_',
          scopes: ['*'],
          is_active: true,
          created_at: '2024-01-01',
        },
      ],
    }),
  );
  const listProvidersAdmin = jest.fn(() =>
    of({
      providers: [
        {
          id: 'p1',
          name: 'Keycloak',
          issuer: 'https://idp',
          client_id: 'client',
          is_active: true,
          from_env: false,
          created_at: '2024-01-01',
          updated_at: '2024-01-02',
          discovery_url: 'https://idp/.well-known',
          scopes: ['openid'],
          trust_email: true,
        },
      ],
    }),
  );
  const upsertProvider = jest.fn(() =>
    of({
      provider: {
        id: 'p2',
        name: 'ADFS',
        issuer: 'https://adfs',
        client_id: 'c2',
        is_active: true,
        from_env: true,
        created_at: '2024-01-01',
        updated_at: '2024-01-02',
        discovery_url: '',
        scopes: [],
        trust_email: false,
      },
    }),
  );
  const deactivateProvider = jest.fn(() => of({ ok: true }));

  function make(): SystemAuthBffController {
    const authClient = {
      getService: jest.fn((name: string) => {
        if (name === 'ApiKeyGrpc') return { listServiceApiKeys };
        if (name === 'OidcGrpc') return { listProvidersAdmin, upsertProvider, deactivateProvider };
        return {};
      }),
    };
    const ctrl = new SystemAuthBffController(authClient as never, outboundMeta as never);
    ctrl.onModuleInit();
    return ctrl;
  }

  beforeEach(() => {
    jest.clearAllMocks();
    mockedGrpcBffCall.mockImplementation(async (obs) => {
      const { firstValueFrom } = await import('rxjs');
      return firstValueFrom(obs as never);
    });
  });

  it('lists service API keys with camelCase projection', async () => {
    const ctrl = make();
    const res = await ctrl.listServiceApiKeys({ headers: {}, user: { userId: 'admin' } } as never);
    expect(res.keys[0]).toMatchObject({
      id: 'k1',
      name: 'gateway',
      keyPrefix: 'ak_',
      scopes: ['*'],
      isActive: true,
    });
  });

  it('lists OIDC providers for admin UI', async () => {
    const ctrl = make();
    const res = await ctrl.listOidcProviders({ headers: {} } as never);
    expect(res.providers[0]).toMatchObject({
      id: 'p1',
      name: 'Keycloak',
      clientId: 'client',
      trustEmail: true,
    });
  });

  it('upserts OIDC provider and maps snake_case wire fields', async () => {
    const ctrl = make();
    const res = await ctrl.upsertOidcProvider({ headers: {} } as never, {
      name: 'ADFS',
      issuer: 'https://adfs',
      clientId: 'c2',
      isActive: true,
    });
    expect(upsertProvider).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'ADFS', client_id: 'c2', is_active: true }),
      {},
    );
    expect(res.provider.name).toBe('ADFS');
  });

  it('patchOidcProvider merges route id into body', async () => {
    const ctrl = make();
    await ctrl.patchOidcProvider({ headers: {} } as never, 'p9', { name: 'X' });
    expect(upsertProvider).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'p9', name: 'X' }),
      {},
    );
  });

  it('deactivateOidcProvider returns ok', async () => {
    const ctrl = make();
    await expect(ctrl.deactivateOidcProvider({ headers: {} } as never, 'p1')).resolves.toEqual({
      ok: true,
    });
    expect(deactivateProvider).toHaveBeenCalledWith({ id: 'p1' }, {});
  });
});
