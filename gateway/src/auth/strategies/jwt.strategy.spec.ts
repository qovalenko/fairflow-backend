import { UnauthorizedException } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import { JwtStrategy } from './jwt.strategy';

/**
 * Fail-closed access-token shape checks (TODO-006): the strategy must reject any
 * purpose-scoped token (a payload carrying `kind`, e.g. the 2FA preauth challenge)
 * and any token without a jti — otherwise a leaked preauthId would act as a full
 * Bearer token and would slip past the session deny-list (no jti to check).
 */
function makeStrategy(): JwtStrategy {
  const config = {
    get: (_key: string, def?: string) => def ?? 'test-secret',
  } as unknown as ConfigService;
  return new JwtStrategy(config);
}

const accessPayload = {
  sub: 'u1',
  login: 'alice',
  email: 'alice@example.com',
  jti: 'session-1',
};

describe('JwtStrategy.validate (fail-closed token shape)', () => {
  it('accepts a real access token and maps userId/sessionId', () => {
    expect(makeStrategy().validate(accessPayload)).toEqual({
      userId: 'u1',
      login: 'alice',
      email: 'alice@example.com',
      sessionId: 'session-1',
    });
  });

  it('rejects a 2FA preauth challenge (kind=mfa_challenge) even if the signature passed', () => {
    const preauth = { sub: 'u1', kind: 'mfa_challenge', jti: 'ch1' } as never;
    expect(() => makeStrategy().validate(preauth)).toThrow(UnauthorizedException);
  });

  it('rejects any payload carrying a kind claim (purpose tokens are never sessions)', () => {
    expect(() => makeStrategy().validate({ ...accessPayload, kind: 'pwd_reset' })).toThrow(
      UnauthorizedException,
    );
  });

  it('rejects a token without a jti (nothing for the deny-list to revoke)', () => {
    const { jti: _jti, ...noJti } = accessPayload;
    expect(() => makeStrategy().validate(noJti)).toThrow(UnauthorizedException);
    expect(() => makeStrategy().validate({ ...accessPayload, jti: '' })).toThrow(
      UnauthorizedException,
    );
  });

  it('rejects a token without a subject', () => {
    expect(() => makeStrategy().validate({ ...accessPayload, sub: '' })).toThrow(
      UnauthorizedException,
    );
  });

  it('defaults missing login and email on valid access tokens', () => {
    expect(
      makeStrategy().validate({
        sub: 'u1',
        jti: 'session-1',
      }),
    ).toEqual({
      userId: 'u1',
      login: '',
      email: '',
      sessionId: 'session-1',
    });
  });
});
