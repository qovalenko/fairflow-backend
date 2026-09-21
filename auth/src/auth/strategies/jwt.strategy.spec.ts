import { JwtStrategy } from './jwt.strategy';
import { ACCESS_TOKEN_COOKIE } from '../constants';

describe('JwtStrategy', () => {
  it('maps JWT payload to request user shape', () => {
    const strategy = new JwtStrategy({ get: () => 'secret' } as never);
    expect(
      strategy.validate({
        sub: 'user-1',
        login: 'alice',
        email: 'alice@corp.test',
        jti: 'sess-1',
      }),
    ).toEqual({
      userId: 'user-1',
      login: 'alice',
      email: 'alice@corp.test',
    });
  });

  it('defaults missing email to empty string', () => {
    const strategy = new JwtStrategy({ get: () => 'secret' } as never);
    expect(strategy.validate({ sub: 'u1', login: 'bob', jti: 'sess-2' } as never)).toEqual({
      userId: 'u1',
      login: 'bob',
      email: '',
    });
  });

  it('extracts JWT from access-token cookie before Authorization header', () => {
    const strategy = new JwtStrategy({ get: () => 'secret' } as never);
    const extractor = (strategy as unknown as { _jwtFromRequest: (req: unknown) => string | null })
      ._jwtFromRequest;

    const fromCookie = extractor({
      cookies: { [ACCESS_TOKEN_COOKIE]: 'cookie-jwt' },
      headers: { authorization: 'Bearer header-jwt' },
    });
    expect(fromCookie).toBe('cookie-jwt');

    const fromBearer = extractor({
      cookies: {},
      headers: { authorization: 'Bearer header-only' },
    });
    expect(fromBearer).toBe('header-only');

    expect(extractor({ cookies: {}, headers: {} })).toBeNull();
  });
});
