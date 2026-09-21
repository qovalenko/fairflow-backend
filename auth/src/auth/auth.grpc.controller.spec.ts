import { Test } from '@nestjs/testing';
import { status } from '@grpc/grpc-js';
import { Metadata } from '@grpc/grpc-js';
import { GW_METADATA } from '@fairflow/shared';
import { AuthGrpcController } from './auth.grpc.controller';
import { AuthService } from './auth.service';
import { ProfileService } from './profile.service';
import { AppError } from '../common/errors';

/**
 * Component tests for AuthGrpcController (QA-CI T-036.1, P0 auth) via the Nest
 * TestingModule (control-spec exemplar). AuthService/ProfileService are replaced
 * by mocks — the controller's own logic under test is:
 *  - subject resolution from x-user-id metadata (QA-STRATEGY §7 isolation
 *    invariant): the trusted subject is the gateway metadata, the body is a hint,
 *    and a mismatch is PERMISSION_DENIED (closes the Me/UpdateMe IDOR, auth.md §6.9);
 *  - gRPC status-code mapping of domain errors;
 *  - snake_case wire shaping with defaults.
 */
async function build(auth: Partial<AuthService>, profile: Partial<ProfileService> = {}) {
  const moduleRef = await Test.createTestingModule({
    controllers: [AuthGrpcController],
    providers: [
      { provide: AuthService, useValue: auth },
      { provide: ProfileService, useValue: profile },
    ],
  }).compile();
  return moduleRef.get(AuthGrpcController);
}

/** Gateway-issued metadata carrying the trusted subject (x-user-id). */
function metaWithUser(userId: string, sessionId?: string): Metadata {
  const m = new Metadata();
  m.set(GW_METADATA.USER_ID, userId);
  if (sessionId) m.set(GW_METADATA.SESSION_ID, sessionId);
  return m;
}

const profileRow = { id: 'u1', login: 'alice', email: 'a@x', name: 'Alice' };

describe('AuthGrpcController subject isolation (x-user-id, auth.md §6.9)', () => {
  it('Me: uses the metadata subject and ignores a matching body hint', async () => {
    const me = jest.fn().mockResolvedValue(profileRow);
    const me2faStatus = jest
      .fn()
      .mockResolvedValue({ twoFactorEnabled: false, require2fa: false, backupCodesRemaining: 0 });
    const getPendingEmail = jest.fn().mockResolvedValue('');
    const c = await build({ me, me2faStatus }, { getPendingEmail } as Partial<ProfileService>);
    const res = await c.me({ user_id: 'u1' }, metaWithUser('u1'));
    expect(me).toHaveBeenCalledWith('u1');
    expect(getPendingEmail).toHaveBeenCalledWith('u1');
    expect(res).toMatchObject({ id: 'u1', login: 'alice', pending_email: '' });
  });

  it('Me: PERMISSION_DENIED when the body subject disagrees with the metadata subject (IDOR)', async () => {
    const me = jest.fn();
    const c = await build({ me });
    await expect(c.me({ user_id: 'victim' }, metaWithUser('attacker'))).rejects.toMatchObject({
      error: { code: status.PERMISSION_DENIED, message: 'subject mismatch' },
    });
    // the service is never reached when the subject check fails
    expect(me).not.toHaveBeenCalled();
  });

  it('Me: UNAUTHENTICATED when no subject can be resolved at all', async () => {
    const c = await build({ me: jest.fn() });
    await expect(c.me({}, new Metadata())).rejects.toMatchObject({
      error: { code: status.UNAUTHENTICATED },
    });
  });

  it('UpdateMe: trusts the metadata subject, not the (absent) body', async () => {
    const updateMe = jest.fn().mockResolvedValue(profileRow);
    const c = await build({ updateMe });
    await c.updateMe({ name: 'New' }, metaWithUser('u1'));
    expect(updateMe).toHaveBeenCalledWith('u1', expect.objectContaining({ name: 'New' }));
  });
});

describe('AuthGrpcController session metadata resolution', () => {
  it('Logout: derives the session id from x-session-id metadata when body omits it', async () => {
    const logout = jest.fn().mockResolvedValue(undefined);
    const c = await build({ logout });
    await c.logout({}, metaWithUser('u1', 'jti-42'));
    expect(logout).toHaveBeenCalledWith('u1', 'jti-42');
  });

  it('ValidateSession: passes the resolved subject+session to checkSession and returns its verdict', async () => {
    const checkSession = jest.fn().mockResolvedValue({ valid: false, reason: 'password_changed' });
    const c = await build({ checkSession });
    const res = await c.validateSession({}, metaWithUser('u1', 'jti-42'));
    expect(checkSession).toHaveBeenCalledWith('u1', 'jti-42');
    expect(res).toEqual({ valid: false, reason: 'password_changed' });
  });
});

describe('AuthGrpcController.Login error + shape mapping', () => {
  it('maps a rate-limit lockout to RESOURCE_EXHAUSTED', async () => {
    const loginWithMfa = jest.fn().mockRejectedValue(new AppError('rateLimit', 'locked'));
    const c = await build({ loginWithMfa });
    await expect(c.login({ identifier: 'a', password: 'b' })).rejects.toMatchObject({
      error: { code: status.RESOURCE_EXHAUSTED, message: 'locked' },
    });
  });

  it('maps bad credentials to a generic UNAUTHENTICATED (no enumeration)', async () => {
    const loginWithMfa = jest
      .fn()
      .mockRejectedValue(new AppError('auth', 'Invalid login or password'));
    const c = await build({ loginWithMfa });
    await expect(c.login({ identifier: 'a', password: 'b' })).rejects.toMatchObject({
      error: { code: status.UNAUTHENTICATED, message: 'Invalid credentials' },
    });
  });

  it('returns an mfa_required response (no token) when a second factor is needed', async () => {
    const loginWithMfa = jest.fn().mockResolvedValue({ mfaRequired: true, preauthId: 'pre-1' });
    const c = await build({ loginWithMfa });
    const res = await c.login({ identifier: 'a', password: 'b' });
    expect(res).toMatchObject({ mfa_required: true, preauth_id: 'pre-1', access_token: '' });
  });

  it('shapes a completed login into the snake_case LoginResponse with defaults', async () => {
    const loginWithMfa = jest.fn().mockResolvedValue({
      mfaRequired: false,
      auth: {
        accessToken: 'jwt',
        expiresIn: '24h',
        user: { id: 'u1', login: 'alice', email: 'a@x', name: null },
      },
    });
    const c = await build({ loginWithMfa });
    const res = await c.login({ identifier: 'a', password: 'b' });
    expect(res).toMatchObject({
      access_token: 'jwt',
      expires_in: '24h',
      mfa_required: false,
      user: expect.objectContaining({
        id: 'u1',
        name: '', // null → '' default
        language: 'ru', // default filled in
        default_deals_view: 'kanban',
      }),
    });
  });
});

describe('AuthGrpcController.VerifyMfa error codes', () => {
  const cases: Array<[string, number]> = [
    ['CHALLENGE_EXPIRED', status.FAILED_PRECONDITION],
    ['INVALID_TOTP', status.INVALID_ARGUMENT],
    ['INVALID_CHALLENGE', status.UNAUTHENTICATED],
  ];
  it.each(cases)('maps %s to the right gRPC status', async (msg, code) => {
    const verifyMfa = jest.fn().mockRejectedValue(new Error(msg));
    const c = await build({ verifyMfa });
    await expect(c.verifyMfa({ preauth_id: 'p', code: '1' })).rejects.toMatchObject({
      error: { code, message: msg },
    });
  });
});

describe('AuthGrpcController.Register', () => {
  it('maps an "already exists" error to ALREADY_EXISTS', async () => {
    const register = jest.fn().mockRejectedValue(new Error('User already exists'));
    const c = await build({ register });
    await expect(c.register({ user_name: 'a', email: 'a@x', password: 'p' })).rejects.toMatchObject(
      { error: { code: status.ALREADY_EXISTS } },
    );
  });

  it('accepts snake_case OR camelCase user_name from the wire', async () => {
    const register = jest.fn().mockResolvedValue({
      accessToken: 'jwt',
      expiresIn: '24h',
      user: { id: 'u1', login: 'a', email: 'a@x', name: 'A' },
    });
    const c = await build({ register });
    await c.register({ userName: 'camelName', email: 'a@x', password: 'p' });
    expect(register).toHaveBeenCalledWith('camelName', 'a@x', 'p', expect.anything());
  });
});

describe('AuthGrpcController internal directory (ResolveUsers / RevokeUserSessions)', () => {
  it('ResolveUsers maps profiles to the snake_case directory shape', async () => {
    const resolveUsers = jest
      .fn()
      .mockResolvedValue([
        { id: 'u1', name: 'A', email: 'a@x', login: 'alogin', avatarUrl: 'http://a' },
      ]);
    const c = await build({ resolveUsers });
    const res = await c.resolveUsers({ ids: ['u1'] });
    expect(res.users[0]).toEqual({
      id: 'u1',
      name: 'A',
      email: 'a@x',
      login: 'alogin',
      avatar_url: 'http://a',
    });
  });

  it('RevokeUserSessions returns the revoked count (org-deactivation cascade)', async () => {
    const revokeAllSessionsForUsers = jest.fn().mockResolvedValue(3);
    const c = await build({}, { revokeAllSessionsForUsers });
    const res = await c.revokeUserSessions({ user_ids: ['u1', 'u2'] });
    expect(revokeAllSessionsForUsers).toHaveBeenCalledWith(['u1', 'u2']);
    expect(res).toEqual({ revoked_count: 3 });
  });
});

describe('AuthGrpcController.GetUserByEmail', () => {
  it('returns found:false for an unknown email', async () => {
    const getUserByEmail = jest.fn().mockResolvedValue(null);
    const c = await build({ getUserByEmail });
    expect(await c.getUserByEmail({ email: 'x@y' })).toEqual({ found: false });
  });
});
