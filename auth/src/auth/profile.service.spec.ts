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

/**
 * Component tests for ProfileService (QA-CI T-036.1, P0 auth / profile-module).
 * Prisma/JWT/events mocked at the boundary; the real password-policy, session
 * revoke-guards and — crucially — the FIELD-PROJECTION of a foreign profile
 * (FR-MPROF-25, §19 visibility matrix) run. The projection is a data-isolation
 * boundary: fields a viewer lacks the level for must NEVER leave the domain.
 */
function makeService() {
  const user = { findFirst: jest.fn(), update: jest.fn() };
  const session = {
    findFirst: jest.fn(),
    findMany: jest.fn(),
    update: jest.fn(),
    updateMany: jest.fn(),
    findUnique: jest.fn(),
    aggregate: jest.fn().mockResolvedValue({ _max: { lastSeenAt: null } }),
  };
  const userBackupCode = { deleteMany: jest.fn(), create: jest.fn() };
  const $transaction = jest.fn(async (fn: (tx: unknown) => unknown) =>
    fn({ user, userBackupCode }),
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
  const service = new ProfileService(
    prisma,
    jwt,
    events,
    denyPush as never,
    makeRequire2faPolicy(),
  );
  return { service, user, session, userBackupCode, jwt, events, denyPush };
}

describe('ProfileService.changePassword (FR-MPROF-6/7)', () => {
  it('rejects a wrong current password with PERMISSION_DENIED', async () => {
    const { service, user } = makeService();
    user.findFirst.mockResolvedValue({ id: 'u1', passwordHash: bcrypt.hashSync('current', 4) });
    await expect(
      service.changePassword('u1', 'wrong', 'brand-new-pass', 's1'),
    ).rejects.toMatchObject({
      error: { message: 'INVALID_CREDENTIALS' },
    });
  });

  it('rejects a too-short new password with WEAK_PASSWORD', async () => {
    const { service, user } = makeService();
    user.findFirst.mockResolvedValue({ id: 'u1', passwordHash: bcrypt.hashSync('current', 4) });
    await expect(service.changePassword('u1', 'current', 'short', 's1')).rejects.toMatchObject({
      error: { message: 'WEAK_PASSWORD' },
    });
  });

  it('rejects a new password equal to the current one', async () => {
    const { service, user } = makeService();
    user.findFirst.mockResolvedValue({ id: 'u1', passwordHash: bcrypt.hashSync('current1', 4) });
    await expect(service.changePassword('u1', 'current1', 'current1', 's1')).rejects.toMatchObject({
      error: { message: 'WEAK_PASSWORD' },
    });
  });

  it('NOT_FOUND for an unknown/inactive user', async () => {
    const { service, user } = makeService();
    user.findFirst.mockResolvedValue(null);
    await expect(service.changePassword('u1', 'a', 'brand-new', 's1')).rejects.toMatchObject({
      error: { message: 'User not found' },
    });
  });

  it('updates the hash and revokes other sessions on success', async () => {
    const { service, user, session, events } = makeService();
    user.findFirst.mockResolvedValue({ id: 'u1', passwordHash: bcrypt.hashSync('current1', 4) });
    session.findMany.mockResolvedValue([{ id: 's2' }]);
    session.updateMany.mockResolvedValue({ count: 1 });
    await service.changePassword('u1', 'current1', 'brand-new-pass', 's1');
    expect(user.update).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'u1' } }));
    // current session preserved, others revoked
    expect(session.updateMany).toHaveBeenCalled();
    expect(events.passwordChanged).toHaveBeenCalledWith('u1', 1);
  });
});

describe('ProfileService.revokeSession', () => {
  it('NOT_FOUND for a session that is not the user’s (no cross-user revoke)', async () => {
    const { service, session } = makeService();
    session.findFirst.mockResolvedValue(null);
    await expect(service.revokeSession('u1', 'foreign', 'cur')).rejects.toMatchObject({
      error: { message: 'Session not found' },
    });
  });

  it('refuses to revoke the CURRENT session', async () => {
    const { service, session } = makeService();
    session.findFirst.mockResolvedValue({ id: 's1', tokenId: 'cur', revokedAt: null });
    await expect(service.revokeSession('u1', 's1', 'cur')).rejects.toMatchObject({
      error: { message: 'CANNOT_REVOKE_CURRENT_SESSION' },
    });
  });

  it('revokes another live session and emits the event', async () => {
    const { service, session, events } = makeService();
    session.findFirst.mockResolvedValue({ id: 's2', tokenId: 'other', revokedAt: null });
    session.findUnique.mockResolvedValue({
      tokenId: 'other',
      expiresAt: new Date(Date.now() + 60_000),
    });
    await service.revokeSession('u1', 's2', 'cur');
    expect(session.update).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 's2' } }));
    expect(events.sessionRevoked).toHaveBeenCalledWith('u1', 's2', 'manual');
  });
});

describe('ProfileService.requestEmailChange', () => {
  it('EMAIL_TAKEN (generic) when another account already owns the email', async () => {
    const { service, user } = makeService();
    user.findFirst
      .mockResolvedValueOnce({ id: 'u1', passwordHash: bcrypt.hashSync('pw', 4) }) // self
      .mockResolvedValueOnce({ id: 'other' }); // taken
    await expect(service.requestEmailChange('u1', 'taken@example.com', 'pw')).rejects.toMatchObject(
      { error: { message: 'EMAIL_TAKEN' } },
    );
  });

  it('rejects an invalid email before any DB work', async () => {
    const { service, user } = makeService();
    await expect(service.requestEmailChange('u1', 'not-an-email', 'pw')).rejects.toMatchObject({
      error: { message: 'invalid email' },
    });
    expect(user.findFirst).not.toHaveBeenCalled();
  });
});

describe('ProfileService.cancelMyEmailChange (FR-MPROF-18 self-service cancel)', () => {
  it('drops the pending change for the authenticated subject', async () => {
    const { service, user } = makeService();
    user.findFirst.mockResolvedValue({ id: 'u1', pendingEmail: 'new@example.com' });
    await service.cancelMyEmailChange('u1');
    expect(user.update).toHaveBeenCalledWith({
      where: { id: 'u1' },
      data: { pendingEmail: null },
    });
  });

  it('is idempotent — no update when nothing is pending', async () => {
    const { service, user } = makeService();
    user.findFirst.mockResolvedValue({ id: 'u1', pendingEmail: null });
    await service.cancelMyEmailChange('u1');
    expect(user.update).not.toHaveBeenCalled();
  });

  it('NOT_FOUND for an unknown/inactive user', async () => {
    const { service, user } = makeService();
    user.findFirst.mockResolvedValue(null);
    await expect(service.cancelMyEmailChange('ghost')).rejects.toMatchObject({
      error: { message: 'User not found' },
    });
  });
});

describe('ProfileService.getPendingEmail', () => {
  it('returns the pending email for Me and empty string when none', async () => {
    const { service, user } = makeService();
    user.findFirst.mockResolvedValueOnce({ pendingEmail: 'new@example.com' });
    await expect(service.getPendingEmail('u1')).resolves.toBe('new@example.com');
    user.findFirst.mockResolvedValueOnce({ pendingEmail: null });
    await expect(service.getPendingEmail('u1')).resolves.toBe('');
  });
});

describe('ProfileService.getUserProfileForViewer (FR-MPROF-25 field projection)', () => {
  const target = {
    id: 't1',
    login: 'targetlogin',
    email: 't@example.com',
    name: 'Target',
    avatarUrl: 'http://a',
    phone: '+100',
    position: 'Manager',
    language: 'en',
    timezone: 'UTC',
    dateFormat: 'YYYY',
    timeFormat: '12h',
    thousandsSeparator: 'comma',
    defaultDealsView: 'list',
    defaultActivitiesView: 'kanban',
  };

  it('level 0 (viewer): only name + avatar leave the domain', async () => {
    const { service, user } = makeService();
    user.findFirst.mockResolvedValue(target);
    const p = await service.getUserProfileForViewer('t1', {
      projectRole: 'viewer',
      projectId: 'p1',
    });
    expect(p.name).toBe('Target');
    expect(p.avatar_url).toBe('http://a');
    // higher-level fields must be redacted
    expect(p.email).toBe('');
    expect(p.position).toBe('');
    expect(p.login).toBe('');
    expect(p.phone).toBe('');
  });

  it('level 1 (member): + position, still no email', async () => {
    const { service, user } = makeService();
    user.findFirst.mockResolvedValue(target);
    const p = await service.getUserProfileForViewer('t1', {
      projectRole: 'member',
      projectId: 'p1',
    });
    expect(p.position).toBe('Manager');
    expect(p.email).toBe('');
  });

  it('level 2 (owner): project owner is never below its own admin', async () => {
    const { service, user } = makeService();
    user.findFirst.mockResolvedValue(target);
    const p = await service.getUserProfileForViewer('t1', {
      projectRole: 'owner',
      projectId: 'p1',
    });
    expect(p.email).toBe('t@example.com');
    expect(p.position).toBe('Manager');
    expect(p.login).toBe('');
  });

  it('level 2 (project_admin): + email', async () => {
    const { service, user, session } = makeService();
    user.findFirst.mockResolvedValue(target);
    session.aggregate.mockResolvedValue({
      _max: { lastSeenAt: new Date('2026-01-15T12:00:00.000Z') },
    });
    const p = await service.getUserProfileForViewer('t1', {
      projectRole: 'project_admin',
      projectId: 'p1',
    });
    expect(p.email).toBe('t@example.com');
    expect(p.last_active_at).toBe('2026-01-15T12:00:00.000Z');
    // still not full identity (login/phone are level 3)
    expect(p.login).toBe('');
  });

  it('level 1 (member): no lastActiveAt', async () => {
    const { service, user, session } = makeService();
    user.findFirst.mockResolvedValue(target);
    const p = await service.getUserProfileForViewer('t1', {
      projectRole: 'member',
      projectId: 'p1',
    });
    expect(p.last_active_at).toBe('');
    expect(session.aggregate).not.toHaveBeenCalled();
  });

  it('level 3 (platform_owner): full identity, cross-project (no project context needed)', async () => {
    const { service, user } = makeService();
    user.findFirst.mockResolvedValue(target);
    const p = await service.getUserProfileForViewer('t1', { platformRole: 'platform_owner' });
    expect(p.login).toBe('targetlogin');
    expect(p.email).toBe('t@example.com');
    expect(p.phone).toBe('+100');
    expect(p.language).toBe('en');
  });

  it('requires a project context for non-system roles (FR-MPROF-26a)', async () => {
    const { service } = makeService();
    await expect(
      service.getUserProfileForViewer('t1', { projectRole: 'member' }),
    ).rejects.toMatchObject({ error: { message: 'project context required' } });
  });

  it('NOT_FOUND (existence not revealed beyond scope) for an unknown target', async () => {
    const { service, user } = makeService();
    user.findFirst.mockResolvedValue(null);
    await expect(
      service.getUserProfileForViewer('t1', { projectRole: 'admin', projectId: 'p1' }),
    ).rejects.toMatchObject({ error: { message: 'User not found' } });
  });
});

describe('ProfileService 2FA lifecycle', () => {
  it('init2fa rejects when 2FA is already enabled', async () => {
    const { service, user } = makeService();
    user.findFirst.mockResolvedValue({
      id: 'u1',
      email: 'a@x',
      passwordHash: bcrypt.hashSync('pw', 4),
      twoFactorEnabled: true,
    });
    await expect(service.init2fa('u1', 'pw')).rejects.toMatchObject({
      error: { message: 'ALREADY_ENABLED' },
    });
  });

  it('init2fa stores a pending secret and returns an otpauth URI', async () => {
    const { service, user } = makeService();
    user.findFirst.mockResolvedValue({
      id: 'u1',
      email: 'a@x',
      passwordHash: bcrypt.hashSync('pw', 4),
      twoFactorEnabled: false,
    });
    const r = await service.init2fa('u1', 'pw');
    expect(r.secret).toMatch(/^[A-Z2-7]+$/);
    expect(r.otpauthUri).toContain('otpauth://totp/');
    expect(user.update).toHaveBeenCalled();
  });

  it('enable2fa rejects an INVALID_TOTP code', async () => {
    const { service, user } = makeService();
    // real encrypted pending secret so decrypt works, but the code is wrong
    const { encryptSecret, generateBase32Secret } = await import('./totp.util');
    user.findFirst.mockResolvedValue({
      id: 'u1',
      twoFactorEnabled: false,
      twoFactorPendingSecret: encryptSecret(generateBase32Secret()),
    });
    await expect(service.enable2fa('u1', '000000')).rejects.toMatchObject({
      error: { message: 'INVALID_TOTP' },
    });
  });

  it('enable2fa rejects when there is NO pending secret', async () => {
    const { service, user } = makeService();
    user.findFirst.mockResolvedValue({
      id: 'u1',
      twoFactorEnabled: false,
      twoFactorPendingSecret: null,
    });
    await expect(service.enable2fa('u1', '123456')).rejects.toMatchObject({
      error: { message: 'NO_PENDING_2FA' },
    });
  });

  it('disable2fa rejects when 2FA is not enabled', async () => {
    const { service, user } = makeService();
    user.findFirst.mockResolvedValue({
      id: 'u1',
      passwordHash: bcrypt.hashSync('pw', 4),
      twoFactorEnabled: false,
      twoFactorSecret: null,
    });
    await expect(service.disable2fa('u1', 'pw', '123456')).rejects.toMatchObject({
      error: { message: 'NOT_ENABLED' },
    });
  });
});
