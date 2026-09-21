import { OidcService } from './oidc.service';
import { AppError } from '../common/errors';
import type { PrismaService } from '../prisma/prisma.service';
import type { AppConfigService } from '../config/app-config.service';
import type { AuthService } from '../auth/auth.service';

/**
 * Component tests for the external-SSO identity resolution (FR-AUTH-350).
 * Prisma and AuthService are mocked at the boundary; the linking policy runs
 * for real: (issuer, subject) link wins, binding requires a provider-VERIFIED
 * email, an existing account is linked — never duplicated.
 */
function makeService() {
  const user = { findFirst: jest.fn() };
  const userOidcIdentity = { findUnique: jest.fn(), upsert: jest.fn().mockResolvedValue({}) };
  const oidcProvider = { findMany: jest.fn().mockResolvedValue([]) };
  const prisma = { user, userOidcIdentity, oidcProvider } as unknown as PrismaService;
  const config = { oauth2Issuer: 'http://localhost:3001' } as unknown as AppConfigService;
  const auth = {
    startSessionOrChallenge: jest.fn().mockResolvedValue({
      mfaRequired: false,
      auth: { accessToken: 't', expiresIn: '24h', user: { id: 'u1' } },
    }),
    oauthLogin: jest.fn().mockResolvedValue({
      mfaRequired: false,
      auth: { accessToken: 't', expiresIn: '24h', user: { id: 'u1' } },
    }),
  } as unknown as AuthService;
  const service = new OidcService(prisma, config, auth);
  return { service, user, userOidcIdentity, oidcProvider, auth };
}

const identity = (over: Record<string, unknown> = {}) => ({
  providerId: 'keycloak',
  issuer: 'https://kc.example.com/realms/main',
  subject: 'sub-123',
  email: 'Alice@Example.com',
  emailVerified: true,
  name: 'Alice',
  ...over,
});

afterEach(() => {
  delete process.env.OIDC_PROVIDERS;
});

describe('OidcService.login — identity linking', () => {
  it('links to the EXISTING user by verified email instead of creating a second account', async () => {
    const { service, user, userOidcIdentity, auth } = makeService();
    userOidcIdentity.findUnique.mockResolvedValue(null); // no link yet
    user.findFirst.mockResolvedValue({ id: 'u1' }); // account with this email exists

    const r = await service.login(identity());

    // find-or-create goes through the email-matching path (no duplicate accounts)
    expect(auth.oauthLogin).toHaveBeenCalledWith(
      expect.objectContaining({ email: 'alice@example.com', externalId: 'sub-123' }),
      undefined,
    );
    // and the external identity is persisted against the existing user
    expect(userOidcIdentity.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          issuer_subject: { issuer: 'https://kc.example.com/realms/main', subject: 'sub-123' },
        },
        create: expect.objectContaining({ userId: 'u1', subject: 'sub-123' }),
      }),
    );
    expect(r.auth?.accessToken).toBe('t');
  });

  it('rejects an email the provider did NOT verify (no link, no account)', async () => {
    const { service, userOidcIdentity, auth } = makeService();
    userOidcIdentity.findUnique.mockResolvedValue(null);

    await expect(service.login(identity({ emailVerified: false }))).rejects.toThrow(AppError);
    expect(auth.oauthLogin).not.toHaveBeenCalled();
    expect(userOidcIdentity.upsert).not.toHaveBeenCalled();
  });

  it('rejects when the provider returned no email at all', async () => {
    const { service, userOidcIdentity, auth } = makeService();
    userOidcIdentity.findUnique.mockResolvedValue(null);

    await expect(service.login(identity({ email: '' }))).rejects.toThrow(AppError);
    expect(auth.oauthLogin).not.toHaveBeenCalled();
  });

  it('an existing (issuer, subject) link wins — even if the email changed at the IdP', async () => {
    const { service, user, userOidcIdentity, auth } = makeService();
    userOidcIdentity.findUnique.mockResolvedValue({ userId: 'u1' });
    user.findFirst.mockResolvedValue({ id: 'u1' });

    const r = await service.login(identity({ email: 'renamed@example.com', emailVerified: false }));

    expect(auth.startSessionOrChallenge).toHaveBeenCalledWith('u1', undefined);
    expect(auth.oauthLogin).not.toHaveBeenCalled(); // no re-binding by email
    expect(r.mfaRequired).toBe(false);
  });

  it('a linked but deactivated account cannot log in', async () => {
    const { service, user, userOidcIdentity } = makeService();
    userOidcIdentity.findUnique.mockResolvedValue({ userId: 'u1' });
    user.findFirst.mockResolvedValue(null); // isActive filter finds nothing

    await expect(service.login(identity())).rejects.toThrow('not active');
  });

  it('requires issuer and subject', async () => {
    const { service } = makeService();
    await expect(service.login(identity({ subject: '' }))).rejects.toThrow(AppError);
  });
});

describe('OidcService provider config (env + DB merge)', () => {
  it('merges env providers over DB rows and never leaks secrets in the public list', async () => {
    const { service, oidcProvider } = makeService();
    oidcProvider.findMany.mockResolvedValue([
      {
        id: 'keycloak',
        name: 'DB Keycloak',
        issuer: 'https://db.example.com',
        clientId: 'db-client',
        clientSecret: 'db-secret',
        discoveryUrl: null,
        authorizationEndpoint: null,
        tokenEndpoint: null,
        userInfoEndpoint: null,
        jwksUri: null,
        scopes: [],
        isActive: true,
      },
    ]);
    process.env.OIDC_PROVIDERS = JSON.stringify([
      {
        id: 'keycloak',
        name: 'Env Keycloak',
        issuer: 'https://kc.example.com/realms/main',
        clientId: 'fairflow',
        clientSecret: 'env-secret',
        trustEmail: true,
      },
    ]);

    const list = await service.listProviders();
    expect(list).toEqual([
      { id: 'keycloak', name: 'Env Keycloak', issuer: 'https://kc.example.com/realms/main' },
    ]);
    expect(JSON.stringify(list)).not.toContain('secret');

    const cfg = await service.getProviderConfig('keycloak');
    expect(cfg?.clientSecret).toBe('env-secret'); // env wins on id collision
    expect(cfg?.trustEmail).toBe(true);
    expect(cfg?.scopes).toEqual(['openid', 'profile', 'email']);
  });

  it('honours trustEmail from a DB-only provider (FR-AUTH-357)', async () => {
    const { service, oidcProvider } = makeService();
    oidcProvider.findMany.mockResolvedValue([
      {
        id: 'adfs',
        name: 'ADFS',
        issuer: 'https://adfs.example.com',
        clientId: 'ff',
        clientSecret: 'db-secret',
        discoveryUrl: null,
        authorizationEndpoint: null,
        tokenEndpoint: null,
        userInfoEndpoint: null,
        jwksUri: null,
        scopes: ['openid', 'email'],
        trustEmail: true,
        isActive: true,
      },
    ]);
    const cfg = await service.getProviderConfig('adfs');
    expect(cfg?.trustEmail).toBe(true);
  });

  it('returns undefined for an unknown provider id', async () => {
    const { service } = makeService();
    await expect(service.getProviderConfig('nope')).resolves.toBeUndefined();
  });
});
