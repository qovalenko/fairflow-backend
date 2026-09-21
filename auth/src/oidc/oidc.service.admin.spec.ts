import { OidcService } from './oidc.service';

describe('OidcService admin (OIDC UI)', () => {
  const prisma = {
    oidcProvider: {
      findMany: jest.fn(),
      findUnique: jest.fn(),
      upsert: jest.fn(),
      updateMany: jest.fn(),
    },
  };
  const config = { oauth2Issuer: 'https://example.test' };
  const auth = {};

  const make = () => new OidcService(prisma as never, config as never, auth as never);

  beforeEach(() => {
    jest.resetAllMocks();
    delete process.env.OIDC_PROVIDERS;
  });

  it('lists env providers as read-only rows', async () => {
    process.env.OIDC_PROVIDERS = JSON.stringify([
      { id: 'kc', name: 'Keycloak', issuer: 'https://kc.test', clientId: 'ff' },
    ]);
    prisma.oidcProvider.findMany.mockResolvedValue([]);
    const rows = await make().listProvidersAdmin();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: 'kc', fromEnv: true, isActive: true });
  });

  it('keeps discoveryUrl on update when the field is omitted', async () => {
    prisma.oidcProvider.findUnique.mockResolvedValue({
      id: 'kc-db',
      clientSecret: 'old-secret',
      discoveryUrl: 'https://kc.test/.well-known/openid-configuration',
      authorizationEndpoint: 'https://kc.test/auth',
      tokenEndpoint: 'https://kc.test/token',
      userInfoEndpoint: null,
      jwksUri: null,
      scopes: ['openid', 'email'],
    });
    prisma.oidcProvider.upsert.mockImplementation(
      async ({ update }: { update: Record<string, unknown> }) => ({
        id: 'kc-db',
        name: 'Keycloak',
        issuer: 'https://kc.test',
        clientId: 'ff',
        clientSecret: 'old-secret',
        isActive: true,
        createdAt: new Date('2026-01-01'),
        updatedAt: new Date('2026-01-02'),
        ...update,
      }),
    );
    const row = await make().upsertProvider({
      id: 'kc-db',
      name: 'Keycloak',
      issuer: 'https://kc.test',
      clientId: 'ff',
    });
    expect(prisma.oidcProvider.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        update: expect.objectContaining({
          discoveryUrl: 'https://kc.test/.well-known/openid-configuration',
          authorizationEndpoint: 'https://kc.test/auth',
          scopes: ['openid', 'email'],
        }),
      }),
    );
    expect(row.discoveryUrl).toBe('https://kc.test/.well-known/openid-configuration');
  });

  it('persists trustEmail on upsert (FR-AUTH-357)', async () => {
    prisma.oidcProvider.findUnique.mockResolvedValue(null);
    prisma.oidcProvider.upsert.mockImplementation(
      async ({ create }: { create: Record<string, unknown> }) => ({
        id: 'adfs',
        name: 'ADFS',
        issuer: 'https://adfs.test',
        clientId: 'ff',
        clientSecret: 's',
        isActive: true,
        createdAt: new Date('2026-01-01'),
        updatedAt: new Date('2026-01-02'),
        ...create,
      }),
    );
    const row = await make().upsertProvider({
      id: 'adfs',
      name: 'ADFS',
      issuer: 'https://adfs.test',
      clientId: 'ff',
      clientSecret: 's',
      trustEmail: true,
    });
    expect(prisma.oidcProvider.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({ trustEmail: true }),
      }),
    );
    expect(row.trustEmail).toBe(true);
  });

  it('rejects upsert when id collides with env provider', async () => {
    process.env.OIDC_PROVIDERS = JSON.stringify([
      { id: 'kc', name: 'Keycloak', issuer: 'https://kc.test', clientId: 'ff' },
    ]);
    await expect(
      make().upsertProvider({
        id: 'kc',
        name: 'x',
        issuer: 'https://kc.test',
        clientId: 'ff',
        clientSecret: 'secret',
      }),
    ).rejects.toMatchObject({ errorCode: 'access' });
  });
});
