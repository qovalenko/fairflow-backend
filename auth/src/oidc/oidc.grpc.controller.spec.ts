import { Test } from '@nestjs/testing';
import { status } from '@grpc/grpc-js';
import { OidcGrpcController } from './oidc.grpc.controller';
import { OidcService } from './oidc.service';

async function build(oidc: Partial<OidcService>) {
  const moduleRef = await Test.createTestingModule({
    controllers: [OidcGrpcController],
    providers: [{ provide: OidcService, useValue: oidc }],
  }).compile();
  return moduleRef.get(OidcGrpcController);
}

const authResult = {
  accessToken: 'tok',
  expiresIn: '3600',
  user: {
    id: 'u1',
    login: 'alice',
    email: 'a@x',
    name: 'Alice',
    avatarUrl: 'https://cdn/a.png',
    phone: '+7',
    position: 'Mgr',
    language: 'en',
    timezone: 'UTC',
    dateFormat: 'YYYY-MM-DD',
    timeFormat: '12h',
    thousandsSeparator: 'comma',
    defaultDealsView: 'list',
    defaultActivitiesView: 'calendar',
  },
};

describe('OidcGrpcController wire shaping', () => {
  it('ListProviders maps public provider rows', async () => {
    const listProviders = jest
      .fn()
      .mockResolvedValue([{ id: 'kc', name: 'Keycloak', issuer: 'https://kc/realm' }]);
    const c = await build({ listProviders });
    const res = await c.listProviders();
    expect(res).toEqual({
      providers: [{ id: 'kc', name: 'Keycloak', issuer: 'https://kc/realm' }],
    });
  });

  it('GetProviderConfig returns NOT_FOUND for an unknown id', async () => {
    const getProviderConfig = jest.fn().mockResolvedValue(null);
    const c = await build({ getProviderConfig });
    await expect(c.getProviderConfig({ id: 'missing' })).rejects.toMatchObject({
      error: { code: status.NOT_FOUND, message: 'unknown oidc provider' },
    });
  });

  it('GetProviderConfig maps snake_case config fields', async () => {
    const getProviderConfig = jest.fn().mockResolvedValue({
      id: 'kc',
      name: 'Keycloak',
      issuer: 'https://kc',
      clientId: 'client',
      clientSecret: 'secret',
      discoveryUrl: 'https://kc/.well-known',
      authorizationEndpoint: 'https://kc/auth',
      tokenEndpoint: 'https://kc/token',
      userInfoEndpoint: 'https://kc/userinfo',
      jwksUri: 'https://kc/jwks',
      scopes: ['openid'],
      trustEmail: true,
    });
    const c = await build({ getProviderConfig });
    const res = await c.getProviderConfig({ id: 'kc' });
    expect(res).toMatchObject({
      client_id: 'client',
      client_secret: 'secret',
      discovery_url: 'https://kc/.well-known',
      trust_email: true,
    });
  });
});

describe('OidcGrpcController OidcLogin', () => {
  it('returns snake_case login response on success', async () => {
    const login = jest.fn().mockResolvedValue({ mfaRequired: false, auth: authResult });
    const c = await build({ login });
    const res = await c.oidcLogin({
      provider_id: 'kc',
      issuer: 'https://kc',
      subject: 'sub-1',
      email: 'a@x',
      email_verified: true,
      name: 'Alice',
      avatar_url: 'https://cdn/a.png',
    });
    expect(login).toHaveBeenCalledWith(
      expect.objectContaining({
        providerId: 'kc',
        issuer: 'https://kc',
        subject: 'sub-1',
        emailVerified: true,
      }),
      expect.any(Object),
    );
    expect(res).toMatchObject({
      access_token: 'tok',
      expires_in: '3600',
      mfa_required: false,
      user: expect.objectContaining({ id: 'u1', avatar_url: 'https://cdn/a.png' }),
    });
  });

  it('returns MFA challenge fields without access_token when MFA is required', async () => {
    const login = jest.fn().mockResolvedValue({ mfaRequired: true, preauthId: 'pre-1' });
    const c = await build({ login });
    const res = await c.oidcLogin({ providerId: 'kc', issuer: 'https://kc', subject: 's' });
    expect(res).toEqual({
      access_token: '',
      expires_in: '',
      mfa_required: true,
      preauth_id: 'pre-1',
    });
  });

  it('maps domain errors to UNAUTHENTICATED', async () => {
    const login = jest.fn().mockRejectedValue(new Error('email not verified'));
    const c = await build({ login });
    await expect(
      c.oidcLogin({ providerId: 'kc', issuer: 'https://kc', subject: 's' }),
    ).rejects.toMatchObject({
      error: { code: status.UNAUTHENTICATED, message: 'email not verified' },
    });
  });
});

describe('OidcGrpcController admin surface', () => {
  it('ListProvidersAdmin maps admin rows including from_env', async () => {
    const listProvidersAdmin = jest.fn().mockResolvedValue([
      {
        id: 'kc',
        name: 'Keycloak',
        issuer: 'https://kc',
        clientId: 'c',
        isActive: true,
        fromEnv: true,
        createdAt: new Date('2026-01-01T00:00:00.000Z'),
        updatedAt: new Date('2026-01-02T00:00:00.000Z'),
        discoveryUrl: 'https://kc/.well-known',
        scopes: ['openid'],
        trustEmail: false,
      },
    ]);
    const c = await build({ listProvidersAdmin });
    const res = await c.listProvidersAdmin();
    expect(res.providers[0]).toMatchObject({
      client_id: 'c',
      is_active: true,
      from_env: true,
      created_at: '2026-01-01T00:00:00.000Z',
    });
  });

  it('UpsertProvider maps input aliases and output provider', async () => {
    const upsertProvider = jest.fn().mockResolvedValue({
      id: 'kc',
      name: 'Keycloak',
      issuer: 'https://kc',
      clientId: 'client',
      isActive: true,
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
      updatedAt: new Date('2026-01-02T00:00:00.000Z'),
      discoveryUrl: '',
      scopes: ['openid'],
      trustEmail: true,
    });
    const c = await build({ upsertProvider });
    const res = await c.upsertProvider({
      id: 'kc',
      client_id: 'client',
      client_secret: 'sec',
      discovery_url: '  ',
      trust_email: true,
    });
    expect(upsertProvider).toHaveBeenCalledWith(
      expect.objectContaining({
        clientId: 'client',
        clientSecret: 'sec',
        discoveryUrl: null,
        trustEmail: true,
      }),
    );
    expect(res.provider).toMatchObject({ id: 'kc', trust_email: true, from_env: false });
  });

  it('UpsertProvider maps env-protected errors to FAILED_PRECONDITION', async () => {
    const upsertProvider = jest.fn().mockRejectedValue(new Error('env provider is read-only'));
    const c = await build({ upsertProvider });
    await expect(c.upsertProvider({ id: 'env-kc' })).rejects.toMatchObject({
      error: { code: status.FAILED_PRECONDITION },
    });
  });

  it('UpsertProvider maps validation errors to INVALID_ARGUMENT', async () => {
    const upsertProvider = jest.fn().mockRejectedValue(new Error('issuer required'));
    const c = await build({ upsertProvider });
    await expect(c.upsertProvider({ id: 'kc' })).rejects.toMatchObject({
      error: { code: status.INVALID_ARGUMENT },
    });
  });

  it('DeactivateProvider succeeds and maps failures to FAILED_PRECONDITION', async () => {
    const deactivateProvider = jest.fn().mockResolvedValue(undefined);
    const c = await build({ deactivateProvider });
    await expect(c.deactivateProvider({ id: 'kc' })).resolves.toEqual({});
    deactivateProvider.mockRejectedValue(new Error('env provider'));
    await expect(c.deactivateProvider({ id: 'env-kc' })).rejects.toMatchObject({
      error: { code: status.FAILED_PRECONDITION },
    });
  });
});
