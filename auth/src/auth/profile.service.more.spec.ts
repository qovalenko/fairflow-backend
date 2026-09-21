import * as bcrypt from 'bcryptjs';
import { ProfileService } from './profile.service';
import type { PrismaService } from '../prisma/prisma.service';
import type { JwtService } from '@nestjs/jwt';
import type { ProfileEventsService } from './profile-events.service';
import { Require2faPolicyService } from './require2fa-policy.service';

function makeRequire2faPolicy(required = false): Require2faPolicyService {
  const svc = new Require2faPolicyService();
  svc.setRequired(required);
  return svc;
}
import { encryptSecret, generateBase32Secret, generateTotp, decryptSecret } from './totp.util';

/**
 * Additional ProfileService component tests (QA-CI T-036.1) covering the 2FA
 * enable/disable/regen SUCCESS paths (which run in a $transaction), the
 * email-change confirm flow, and session listing/other-revoke. Prisma/JWT/events
 * mocked at the boundary; the real TOTP verification runs against a live secret.
 */
function makeService() {
  const user = { findFirst: jest.fn(), update: jest.fn().mockResolvedValue({}) };
  const session = {
    findMany: jest.fn(),
    updateMany: jest.fn(),
    findFirst: jest.fn(),
    update: jest.fn(),
  };
  const userBackupCode = {
    deleteMany: jest.fn().mockResolvedValue({}),
    create: jest.fn().mockResolvedValue({}),
    createMany: jest.fn().mockResolvedValue({ count: 10 }),
  };
  const txUser = { update: jest.fn().mockResolvedValue({}) };
  const $transaction = jest.fn(async (fn: (tx: unknown) => unknown) =>
    fn({ user: txUser, userBackupCode }),
  );
  const prisma = { user, session, userBackupCode, $transaction } as unknown as PrismaService;
  const jwt = {
    sign: jest.fn().mockReturnValue('tok'),
    verify: jest.fn(),
  } as unknown as JwtService;
  const events = {
    passwordChanged: jest.fn(),
    emailChangeRequested: jest.fn(),
    emailChanged: jest.fn(),
    twoFactorEnabled: jest.fn(),
    twoFactorDisabled: jest.fn(),
    sessionRevoked: jest.fn(),
  } as unknown as ProfileEventsService;
  const denyPush = {
    pushDenied: jest.fn().mockResolvedValue(undefined),
    pushDeniedMany: jest.fn().mockResolvedValue(undefined),
  };
  return {
    service: new ProfileService(prisma, jwt, events, denyPush as never, makeRequire2faPolicy()),
    user,
    session,
    userBackupCode,
    txUser,
    jwt,
    events,
  };
}

/**
 * A TOTP code currently valid for the given secret. Computed directly (O(1))
 * rather than brute-forced — the old scan of up to 1e6 HMACs was slow under
 * coverage instrumentation and could cross the 30s TOTP window mid-loop,
 * making the enable2fa/disable2fa success cases flaky.
 */
function currentTotp(secret: string): string {
  return generateTotp(secret);
}

describe('ProfileService.enable2fa (success)', () => {
  it('verifies the TOTP, persists the secret and returns backup codes', async () => {
    const { service, user, events, userBackupCode } = makeService();
    const secret = generateBase32Secret();
    user.findFirst.mockResolvedValue({
      id: 'u1',
      twoFactorEnabled: false,
      twoFactorPendingSecret: encryptSecret(secret),
    });
    const codes = await service.enable2fa('u1', currentTotp(secret));
    expect(codes).toHaveLength(10);
    expect(events.twoFactorEnabled).toHaveBeenCalledWith('u1');
    // old codes cleared + all 10 new ones written in one createMany (hashed
    // outside the tx so the tx stays short — BX-07).
    expect(userBackupCode.deleteMany).toHaveBeenCalled();
    expect(userBackupCode.createMany).toHaveBeenCalledTimes(1);
    expect(userBackupCode.createMany.mock.calls[0][0].data).toHaveLength(10);
  }, 30_000);
});

describe('ProfileService.disable2fa (success)', () => {
  it('checks password + TOTP then clears 2FA', async () => {
    const { service, user, txUser, events } = makeService();
    const secret = generateBase32Secret();
    user.findFirst.mockResolvedValue({
      id: 'u1',
      passwordHash: bcrypt.hashSync('pw', 4),
      twoFactorEnabled: true,
      twoFactorSecret: encryptSecret(secret),
    });
    // sanity: our secret decrypts back
    expect(decryptSecret(encryptSecret(secret))).toBe(secret);
    await service.disable2fa('u1', 'pw', currentTotp(secret));
    expect(txUser.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ twoFactorEnabled: false }) }),
    );
    expect(events.twoFactorDisabled).toHaveBeenCalledWith('u1');
  });

  it('rejects a wrong current password with PERMISSION_DENIED', async () => {
    const { service, user } = makeService();
    user.findFirst.mockResolvedValue({
      id: 'u1',
      passwordHash: bcrypt.hashSync('pw', 4),
      twoFactorEnabled: true,
      twoFactorSecret: encryptSecret(generateBase32Secret()),
    });
    await expect(service.disable2fa('u1', 'wrong', '123456')).rejects.toMatchObject({
      error: { message: 'INVALID_CREDENTIALS' },
    });
  });
});

describe('ProfileService.disable2fa (require2fa policy)', () => {
  it('rejects disable when org policy requires 2FA', async () => {
    const user = { findFirst: jest.fn(), update: jest.fn().mockResolvedValue({}) };
    const session = {
      findMany: jest.fn(),
      updateMany: jest.fn(),
      findFirst: jest.fn(),
      update: jest.fn(),
    };
    const userBackupCode = {
      deleteMany: jest.fn().mockResolvedValue({}),
      create: jest.fn().mockResolvedValue({}),
      createMany: jest.fn().mockResolvedValue({ count: 10 }),
    };
    const txUser = { update: jest.fn().mockResolvedValue({}) };
    const $transaction = jest.fn(async (fn: (tx: unknown) => unknown) =>
      fn({ user: txUser, userBackupCode }),
    );
    const prisma = { user, session, userBackupCode, $transaction } as unknown as PrismaService;
    const jwt = { sign: jest.fn(), verify: jest.fn() } as unknown as JwtService;
    const events = {
      twoFactorDisabled: jest.fn(),
    } as unknown as ProfileEventsService;
    const secret = generateBase32Secret();
    user.findFirst.mockResolvedValue({
      id: 'u1',
      passwordHash: bcrypt.hashSync('pw', 4),
      twoFactorEnabled: true,
      twoFactorSecret: encryptSecret(secret),
    });
    const denyPush = {
      pushDenied: jest.fn().mockResolvedValue(undefined),
      pushDeniedMany: jest.fn().mockResolvedValue(undefined),
    };
    const service = new ProfileService(
      prisma,
      jwt,
      events,
      denyPush as never,
      makeRequire2faPolicy(true),
    );
    await expect(service.disable2fa('u1', 'pw', currentTotp(secret))).rejects.toMatchObject({
      error: { message: 'TWO_FACTOR_REQUIRED_BY_POLICY' },
    });
    expect(events.twoFactorDisabled).not.toHaveBeenCalled();
  });
});

describe('ProfileService.regenBackupCodes', () => {
  it('rejects when 2FA is not enabled', async () => {
    const { service, user } = makeService();
    user.findFirst.mockResolvedValue({ id: 'u1', twoFactorEnabled: false });
    await expect(service.regenBackupCodes('u1', 'pw', '123456')).rejects.toMatchObject({
      error: { message: 'NOT_ENABLED' },
    });
  });

  it('regenerates 10 fresh codes when enabled', async () => {
    const { service, user, userBackupCode } = makeService();
    const secret = generateBase32Secret();
    user.findFirst.mockResolvedValue({
      id: 'u1',
      passwordHash: bcrypt.hashSync('pw', 4),
      twoFactorEnabled: true,
      twoFactorSecret: encryptSecret(secret),
    });
    const codes = await service.regenBackupCodes('u1', 'pw', currentTotp(secret));
    expect(codes).toHaveLength(10);
    expect(userBackupCode.createMany).toHaveBeenCalledTimes(1);
    expect(userBackupCode.createMany.mock.calls[0][0].data).toHaveLength(10);
  }, 15000);
});

describe('ProfileService.confirmEmailChange', () => {
  it('applies the pending email and marks it verified', async () => {
    const { service, user, jwt, events } = makeService();
    (jwt.verify as jest.Mock).mockReturnValue({ sub: 'u1', ec: 'new@x', kind: 'email_change' });
    user.findFirst
      .mockResolvedValueOnce({ id: 'u1', pendingEmail: 'new@x' }) // match
      .mockResolvedValueOnce(null); // uniqueness re-check → free
    const uid = await service.confirmEmailChange('tok');
    expect(uid).toBe('u1');
    expect(user.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ email: 'new@x', emailVerified: true }),
      }),
    );
    expect(events.emailChanged).toHaveBeenCalledWith('u1');
  });

  it('TOKEN_EXPIRED for an invalid/expired token', async () => {
    const { service, jwt } = makeService();
    (jwt.verify as jest.Mock).mockImplementation(() => {
      throw new Error('bad');
    });
    await expect(service.confirmEmailChange('tok')).rejects.toMatchObject({
      error: { message: 'TOKEN_EXPIRED' },
    });
  });

  it('TOKEN_EXPIRED (idempotent) when the pending email no longer matches', async () => {
    const { service, user, jwt } = makeService();
    (jwt.verify as jest.Mock).mockReturnValue({ sub: 'u1', ec: 'new@x', kind: 'email_change' });
    user.findFirst.mockResolvedValue({ id: 'u1', pendingEmail: 'different@x' });
    await expect(service.confirmEmailChange('tok')).rejects.toMatchObject({
      error: { message: 'TOKEN_EXPIRED' },
    });
  });
});

describe('ProfileService.cancelEmailChange', () => {
  it('clears pending email when the cancel token matches', async () => {
    const { service, user, jwt } = makeService();
    (jwt.verify as jest.Mock).mockReturnValue({
      sub: 'u1',
      ec: 'new@x',
      kind: 'email_change_cancel',
    });
    user.findFirst.mockResolvedValue({ id: 'u1', pendingEmail: 'new@x' });
    await service.cancelEmailChange('tok');
    expect(user.update).toHaveBeenCalledWith({
      where: { id: 'u1' },
      data: { pendingEmail: null },
    });
  });
});

describe('ProfileService.listSessions / revokeOtherSessions', () => {
  it('listSessions marks the current token and fills device defaults', async () => {
    const { service, session } = makeService();
    const now = new Date();
    session.findMany.mockResolvedValue([
      { id: 's1', tokenId: 'cur', deviceLabel: null, ip: null, lastSeenAt: now, createdAt: now },
      {
        id: 's2',
        tokenId: 'other',
        deviceLabel: 'Phone',
        ip: '9.9.9.9',
        lastSeenAt: null,
        createdAt: now,
      },
    ]);
    const rows = await service.listSessions('u1', 'cur');
    expect(rows[0]).toMatchObject({
      id: 's1',
      isCurrent: true,
      deviceLabel: 'Unknown device',
      ip: '',
    });
    expect(rows[1]).toMatchObject({ id: 's2', isCurrent: false, deviceLabel: 'Phone' });
  });

  it('revokeOtherSessions returns 0 when there is nothing to revoke', async () => {
    const { service, session } = makeService();
    session.findMany.mockResolvedValue([]);
    expect(await service.revokeOtherSessions('u1', 'cur')).toBe(0);
    expect(session.updateMany).not.toHaveBeenCalled();
  });

  it('revokeOtherSessions revokes the victims and emits an event each', async () => {
    const { service, session, events } = makeService();
    session.findMany.mockResolvedValue([{ id: 's2' }, { id: 's3' }]);
    session.updateMany.mockResolvedValue({ count: 2 });
    const n = await service.revokeOtherSessions('u1', 'cur', 'revoke_others');
    expect(n).toBe(2);
    expect(events.sessionRevoked).toHaveBeenCalledTimes(2);
  });
});
