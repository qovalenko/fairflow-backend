import { createHash, generateKeyPairSync } from 'node:crypto';
import { URL } from 'node:url';
import { JwtService } from '@nestjs/jwt';
import {
  OidcClientService,
  type OidcEndpoints,
  type OidcProviderWire,
} from './oidc-client.service';

/**
 * Security tests for the OIDC relying-party mechanics (FR-AUTH-350):
 * PKCE is S256-only, state is one-time (substitution/replay dies), and the
 * id_token is rejected on nonce mismatch, bad signature, wrong iss/aud or a
 * non-allow-listed alg (none/HS*).
 */
const provider: OidcProviderWire = {
  id: 'keycloak',
  name: 'Corporate SSO',
  issuer: 'https://kc.example.com/realms/main',
  client_id: 'fairflow',
  client_secret: 's3cret',
  scopes: ['openid', 'profile', 'email'],
};

const endpoints: OidcEndpoints = {
  authorizationEndpoint: 'https://kc.example.com/realms/main/protocol/openid-connect/auth',
  tokenEndpoint: 'https://kc.example.com/realms/main/protocol/openid-connect/token',
  jwksUri: 'https://kc.example.com/realms/main/protocol/openid-connect/certs',
};

const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const publicPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
const privatePem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();

const otherKeys = generateKeyPairSync('rsa', { modulusLength: 2048 });
const otherPrivatePem = otherKeys.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();

function makeService(): OidcClientService {
  const svc = new OidcClientService(new JwtService({}));
  jest.spyOn(svc, 'getPublicKey').mockResolvedValue(publicPem);
  return svc;
}

async function signIdToken(
  over: Record<string, unknown> = {},
  opts: { privateKey?: string; issuer?: string; audience?: string } = {},
): Promise<string> {
  const jwt = new JwtService({});
  return jwt.signAsync(
    {
      sub: 'sub-123',
      email: 'alice@example.com',
      email_verified: true,
      name: 'Alice',
      nonce: 'nonce-1',
      ...over,
    },
    {
      privateKey: opts.privateKey ?? privatePem,
      algorithm: 'RS256',
      keyid: 'k1',
      issuer: opts.issuer ?? provider.issuer,
      audience: opts.audience ?? provider.client_id,
      expiresIn: '5m',
    },
  );
}

describe('PKCE (S256 only)', () => {
  it('authorize URL carries an S256 challenge derived from the stored verifier', () => {
    const svc = makeService();
    const { authorizeUrl, state } = svc.begin(provider, endpoints, 'https://gw/cb', 'https://spa');
    const url = new URL(authorizeUrl);

    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('client_id')).toBe('fairflow');

    const entry = svc.consumeState(state)!;
    expect(entry.codeVerifier.length).toBeGreaterThanOrEqual(43); // RFC 7636 §4.1
    const expected = createHash('sha256').update(entry.codeVerifier).digest('base64url');
    expect(url.searchParams.get('code_challenge')).toBe(expected);
    // the raw verifier must never leak into the authorize redirect ("plain" mode)
    expect(authorizeUrl).not.toContain(entry.codeVerifier);
  });

  it('every login gets a fresh state, nonce and verifier', () => {
    const svc = makeService();
    const a = svc.begin(provider, endpoints, 'https://gw/cb', 'https://spa');
    const b = svc.begin(provider, endpoints, 'https://gw/cb', 'https://spa');
    expect(a.state).not.toBe(b.state);
    const ea = svc.consumeState(a.state)!;
    const eb = svc.consumeState(b.state)!;
    expect(ea.nonce).not.toBe(eb.nonce);
    expect(ea.codeVerifier).not.toBe(eb.codeVerifier);
  });
});

describe('state substitution / replay', () => {
  it('unknown (attacker-supplied) state is rejected', () => {
    const svc = makeService();
    svc.begin(provider, endpoints, 'https://gw/cb', 'https://spa');
    expect(svc.consumeState('forged-state')).toBeUndefined();
  });

  it('state is one-time: a second consume (replayed callback) is rejected', () => {
    const svc = makeService();
    const { state } = svc.begin(provider, endpoints, 'https://gw/cb', 'https://spa');
    expect(svc.consumeState(state)).toBeDefined();
    expect(svc.consumeState(state)).toBeUndefined();
  });

  it('missing state is rejected', () => {
    const svc = makeService();
    expect(svc.consumeState(undefined)).toBeUndefined();
  });
});

describe('id_token validation', () => {
  it('accepts a properly signed token with matching iss/aud/nonce', async () => {
    const svc = makeService();
    const token = await signIdToken();
    const claims = await svc.verifyIdToken(provider, endpoints, token, 'nonce-1');
    expect(claims).toMatchObject({
      subject: 'sub-123',
      email: 'alice@example.com',
      emailVerified: true,
    });
  });

  it('rejects a nonce mismatch (token replayed from another login attempt)', async () => {
    const svc = makeService();
    const token = await signIdToken({ nonce: 'stolen-nonce' });
    await expect(svc.verifyIdToken(provider, endpoints, token, 'nonce-1')).rejects.toThrow();
  });

  it('rejects a token signed by a different key', async () => {
    const svc = makeService();
    const token = await signIdToken({}, { privateKey: otherPrivatePem });
    await expect(svc.verifyIdToken(provider, endpoints, token, 'nonce-1')).rejects.toThrow();
  });

  it('rejects wrong issuer and wrong audience', async () => {
    const svc = makeService();
    const badIss = await signIdToken({}, { issuer: 'https://evil.example.com' });
    await expect(svc.verifyIdToken(provider, endpoints, badIss, 'nonce-1')).rejects.toThrow();
    const badAud = await signIdToken({}, { audience: 'other-client' });
    await expect(svc.verifyIdToken(provider, endpoints, badAud, 'nonce-1')).rejects.toThrow();
  });

  it('rejects symmetric and "none" algorithms outright', async () => {
    const svc = makeService();
    const hs = await new JwtService({}).signAsync(
      { sub: 'sub-123', nonce: 'nonce-1' },
      { secret: 'guessable', algorithm: 'HS256', issuer: provider.issuer },
    );
    await expect(svc.verifyIdToken(provider, endpoints, hs, 'nonce-1')).rejects.toThrow(
      /alg not allowed/,
    );

    const header = Buffer.from(JSON.stringify({ alg: 'none' })).toString('base64url');
    const payload = Buffer.from(
      JSON.stringify({ sub: 'sub-123', nonce: 'nonce-1', iss: provider.issuer }),
    ).toString('base64url');
    await expect(
      svc.verifyIdToken(provider, endpoints, `${header}.${payload}.`, 'nonce-1'),
    ).rejects.toThrow(/alg not allowed/);
  });

  it('rejects an expired token', async () => {
    const svc = makeService();
    const jwt = new JwtService({});
    const token = await jwt.signAsync(
      { sub: 'sub-123', nonce: 'nonce-1' },
      {
        privateKey: privatePem,
        algorithm: 'RS256',
        issuer: provider.issuer,
        audience: provider.client_id,
        expiresIn: '-1m',
      },
    );
    await expect(svc.verifyIdToken(provider, endpoints, token, 'nonce-1')).rejects.toThrow();
  });
});
