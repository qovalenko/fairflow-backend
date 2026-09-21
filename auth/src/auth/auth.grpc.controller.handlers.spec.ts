import { Test } from '@nestjs/testing';
import { status } from '@grpc/grpc-js';
import { Metadata } from '@grpc/grpc-js';
import { GW_METADATA } from '@fairflow/shared';
import { AuthGrpcController } from './auth.grpc.controller';
import { AuthService } from './auth.service';
import { ProfileService } from './profile.service';

/**
 * Component tests for the remaining AuthGrpcController handlers (QA-CI T-036.1) —
 * the thin gRPC delegations to Auth/ProfileService. Focus: each handler resolves
 * the trusted subject from x-user-id metadata (never the body), forwards the
 * snake_case/camelCase wire fields correctly, and shapes the response. Business
 * logic itself is covered by the *.service.spec files.
 */
async function build(auth: Partial<AuthService> = {}, profile: Partial<ProfileService> = {}) {
  const moduleRef = await Test.createTestingModule({
    controllers: [AuthGrpcController],
    providers: [
      { provide: AuthService, useValue: auth },
      { provide: ProfileService, useValue: profile },
    ],
  }).compile();
  return moduleRef.get(AuthGrpcController);
}

function metaWithUser(userId: string): Metadata {
  const m = new Metadata();
  m.set(GW_METADATA.USER_ID, userId);
  return m;
}

describe('AuthGrpcController.OauthLogin', () => {
  it('shapes a completed oauth login', async () => {
    const oauthLogin = jest.fn().mockResolvedValue({
      mfaRequired: false,
      auth: {
        accessToken: 'jwt',
        expiresIn: '24h',
        user: { id: 'u1', login: 'a', email: 'a@x', name: 'A' },
      },
    });
    const c = await build({ oauthLogin });
    const res = await c.oauthLogin({ provider: 'yandex', external_id: 'ext', email: 'a@x' });
    expect(res).toMatchObject({ access_token: 'jwt', mfa_required: false });
    expect(oauthLogin).toHaveBeenCalledWith(
      expect.objectContaining({ provider: 'yandex', externalId: 'ext', email: 'a@x' }),
      expect.anything(),
    );
  });

  it('returns mfa_required when the oauth account has 2FA', async () => {
    const oauthLogin = jest.fn().mockResolvedValue({ mfaRequired: true, preauthId: 'p' });
    const c = await build({ oauthLogin });
    expect(await c.oauthLogin({ provider: 'y', email: 'a@x' })).toMatchObject({
      mfa_required: true,
      preauth_id: 'p',
    });
  });

  it('maps a provider error to INVALID_ARGUMENT', async () => {
    const oauthLogin = jest.fn().mockRejectedValue(new Error('no email'));
    const c = await build({ oauthLogin });
    await expect(c.oauthLogin({ provider: 'y' })).rejects.toMatchObject({
      error: { code: status.INVALID_ARGUMENT },
    });
  });
});

describe('AuthGrpcController.ProvisionUser / ListUsers', () => {
  it('ProvisionUser returns the wired user + created flag', async () => {
    const provisionUser = jest.fn().mockResolvedValue({
      user: { id: 'u1', login: 'a', email: 'a@x', name: 'A' },
      created: true,
    });
    const c = await build({ provisionUser });
    const res = await c.provisionUser({ email: 'a@x', name: 'A', password: 'p' });
    expect(res).toMatchObject({ created: true, user: { id: 'u1' } });
  });

  it('ListUsers maps rows to the snake_case list shape with total', async () => {
    const listUsers = jest.fn().mockResolvedValue({
      list: [
        {
          id: 'u1',
          login: 'a',
          email: 'a@x',
          name: 'A',
          isActive: true,
          createdAt: new Date('2026-01-01'),
        },
      ],
      total: 1,
    });
    const c = await build({ listUsers });
    const res = await c.listUsers({ skip: 0, take: 10 });
    expect(res.total).toBe(1);
    expect(res.list[0]).toMatchObject({
      id: 'u1',
      is_active: true,
      created_at: '2026-01-01T00:00:00.000Z',
    });
  });
});

describe('AuthGrpcController profile mutations (subject from metadata)', () => {
  it('ChangePassword forwards the resolved subject + password fields', async () => {
    const changePassword = jest.fn().mockResolvedValue(undefined);
    const c = await build({}, { changePassword });
    await c.changePassword(
      { current_password: 'old', new_password: 'newlongpass', current_session_id: 's1' },
      metaWithUser('u1'),
    );
    expect(changePassword).toHaveBeenCalledWith('u1', 'old', 'newlongpass', 's1');
  });

  it('RequestEmailChange returns the confirm token', async () => {
    const requestEmailChange = jest.fn().mockResolvedValue({
      confirmToken: 'ct',
      currentEmail: 'old@x',
      cancelToken: 'cancel',
    });
    const c = await build({}, { requestEmailChange });
    const res = await c.requestEmailChange(
      { new_email: 'n@x', current_password: 'pw' },
      metaWithUser('u1'),
    );
    expect(res).toEqual({
      confirm_token: 'ct',
      current_email: 'old@x',
      cancel_token: 'cancel',
    });
    expect(requestEmailChange).toHaveBeenCalledWith('u1', 'n@x', 'pw');
  });

  it('ConfirmEmailChange re-reads the profile and returns the wire user', async () => {
    const confirmEmailChange = jest.fn().mockResolvedValue('u1');
    const me = jest.fn().mockResolvedValue({ id: 'u1', login: 'a', email: 'n@x', name: 'A' });
    const c = await build({ me }, { confirmEmailChange });
    const res = await c.confirmEmailChange({ token: 't' });
    expect(res).toMatchObject({ id: 'u1', email: 'n@x' });
  });

  it('ConfirmEmailChange NOT_FOUND when the profile vanished', async () => {
    const confirmEmailChange = jest.fn().mockResolvedValue('u1');
    const me = jest.fn().mockResolvedValue(null);
    const c = await build({ me }, { confirmEmailChange });
    await expect(c.confirmEmailChange({ token: 't' })).rejects.toMatchObject({
      error: { code: status.NOT_FOUND },
    });
  });
});

describe('AuthGrpcController 2FA handlers', () => {
  it('Init2fa returns otpauth uri + secret', async () => {
    const init2fa = jest.fn().mockResolvedValue({ otpauthUri: 'otpauth://x', secret: 'S' });
    const c = await build({}, { init2fa });
    expect(await c.init2fa({ current_password: 'pw' }, metaWithUser('u1'))).toEqual({
      otpauth_uri: 'otpauth://x',
      secret: 'S',
    });
    expect(init2fa).toHaveBeenCalledWith('u1', 'pw');
  });

  it('Enable2fa returns backup codes', async () => {
    const enable2fa = jest.fn().mockResolvedValue(['a-b', 'c-d']);
    const c = await build({}, { enable2fa });
    expect(await c.enable2fa({ totp_code: '123456' }, metaWithUser('u1'))).toEqual({
      backup_codes: ['a-b', 'c-d'],
    });
    expect(enable2fa).toHaveBeenCalledWith('u1', '123456');
  });

  it('Disable2fa forwards password + totp', async () => {
    const disable2fa = jest.fn().mockResolvedValue(undefined);
    const c = await build({}, { disable2fa });
    await c.disable2fa({ current_password: 'pw', totp_code: '123456' }, metaWithUser('u1'));
    expect(disable2fa).toHaveBeenCalledWith('u1', 'pw', '123456');
  });

  it('RegenBackupCodes returns the new codes', async () => {
    const regenBackupCodes = jest.fn().mockResolvedValue(['x-y']);
    const c = await build({}, { regenBackupCodes });
    expect(
      await c.regenBackupCodes({ current_password: 'pw', totp_code: '123456' }, metaWithUser('u1')),
    ).toEqual({ backup_codes: ['x-y'] });
    expect(regenBackupCodes).toHaveBeenCalledWith('u1', 'pw', '123456');
  });
});

describe('AuthGrpcController session handlers', () => {
  it('ListSessions maps to the snake_case session shape', async () => {
    const listSessions = jest.fn().mockResolvedValue([
      {
        id: 's1',
        deviceLabel: 'Chrome',
        ip: '1.2.3.4',
        lastSeenAt: '2026-01-01T00:00:00.000Z',
        createdAt: '2026-01-01T00:00:00.000Z',
        isCurrent: true,
      },
    ]);
    const c = await build({}, { listSessions });
    const res = await c.listSessions({ current_token_id: 'cur' }, metaWithUser('u1'));
    expect(res.sessions[0]).toMatchObject({ id: 's1', device_label: 'Chrome', is_current: true });
    expect(listSessions).toHaveBeenCalledWith('u1', 'cur');
  });

  it('RevokeSession forwards subject/session/current', async () => {
    const revokeSession = jest.fn().mockResolvedValue(undefined);
    const c = await build({}, { revokeSession });
    await c.revokeSession({ session_id: 's2', current_token_id: 'cur' }, metaWithUser('u1'));
    expect(revokeSession).toHaveBeenCalledWith('u1', 's2', 'cur');
  });

  it('RevokeOtherSessions returns the revoked count', async () => {
    const revokeOtherSessions = jest.fn().mockResolvedValue(4);
    const c = await build({}, { revokeOtherSessions });
    const res = await c.revokeOtherSessions({ current_token_id: 'cur' }, metaWithUser('u1'));
    expect(res).toEqual({ revoked: 4 });
  });
});

describe('AuthGrpcController password-recovery / email-verification handlers', () => {
  it('RequestPasswordReset passes through the non-enumerating result', async () => {
    const requestPasswordReset = jest
      .fn()
      .mockResolvedValue({ found: false, resetToken: '', email: '', name: '' });
    const c = await build({ requestPasswordReset });
    expect(await c.requestPasswordReset({ email: 'x@y' })).toMatchObject({ found: false });
  });

  it('ResetPassword delegates token + new password', async () => {
    const resetPassword = jest.fn().mockResolvedValue(undefined);
    const c = await build({ resetPassword });
    await c.resetPassword({ token: 't', new_password: 'longpass1' });
    expect(resetPassword).toHaveBeenCalledWith('t', 'longpass1');
  });

  it('RequestEmailVerification maps the wire flags', async () => {
    const requestEmailVerification = jest.fn().mockResolvedValue({
      found: true,
      alreadyVerified: false,
      verifyToken: 'vt',
      email: 'a@x',
      name: 'A',
    });
    const c = await build({ requestEmailVerification });
    const res = await c.requestEmailVerification({ user_id: 'u1' });
    expect(res).toMatchObject({ found: true, already_verified: false, verify_token: 'vt' });
  });

  it('ConfirmEmailVerification returns the user id', async () => {
    const confirmEmailVerification = jest.fn().mockResolvedValue('u1');
    const c = await build({ confirmEmailVerification });
    expect(await c.confirmEmailVerification({ token: 't' })).toEqual({ user_id: 'u1' });
  });
});

describe('AuthGrpcController.GetUserProfileForViewer', () => {
  it('INVALID_ARGUMENT when no target id is given', async () => {
    const c = await build({}, { getUserProfileForViewer: jest.fn() });
    await expect(c.getUserProfileForViewer({})).rejects.toMatchObject({
      error: { code: status.INVALID_ARGUMENT },
    });
  });

  it('delegates the target + viewer context (snake_case → camelCase)', async () => {
    const getUserProfileForViewer = jest.fn().mockResolvedValue({ id: 't1', name: 'T' });
    const c = await build({}, { getUserProfileForViewer });
    await c.getUserProfileForViewer({
      target_id: 't1',
      viewer_context: { project_role: 'member', project_id: 'p1' },
    });
    expect(getUserProfileForViewer).toHaveBeenCalledWith('t1', {
      projectRole: 'member',
      platformRole: undefined,
      projectId: 'p1',
    });
  });
});
