import { ProfileService } from './profile.service';
import type { PrismaService } from '../prisma/prisma.service';
import type { JwtService } from '@nestjs/jwt';
import type { ProfileEventsService } from './profile-events.service';
import { Require2faPolicyService } from './require2fa-policy.service';

/**
 * P2.e (be-org-deactivate-cascade): ProfileService.revokeAllSessionsForUsers is
 * the auth side of the org-deactivation cascade. It must mark EVERY live session
 * of the given users revoked (revokedAt set) so ValidateSession denies their
 * tokens — no session is preserved (unlike the user-facing revoke paths).
 */
describe('ProfileService.revokeAllSessionsForUsers', () => {
  function makeService() {
    const sessions = {
      findMany: jest.fn(),
      updateMany: jest.fn(),
    };
    const prisma = { session: sessions } as unknown as PrismaService;
    const events = { sessionRevoked: jest.fn() } as unknown as ProfileEventsService;
    const jwt = {} as unknown as JwtService;
    const denyPush = {
      pushDenied: jest.fn().mockResolvedValue(undefined),
      pushDeniedMany: jest.fn().mockResolvedValue(undefined),
    };
    const service = new ProfileService(
      prisma,
      jwt,
      events,
      denyPush as never,
      new Require2faPolicyService(),
    );
    return { service, sessions, events, denyPush };
  }

  it('revokes all live sessions of the given users and returns the count', async () => {
    const { service, sessions, events } = makeService();
    sessions.findMany.mockResolvedValue([
      { id: 's1', userId: 'u1', tokenId: 't1', expiresAt: new Date(Date.now() + 60_000) },
      { id: 's2', userId: 'u1', tokenId: 't2', expiresAt: new Date(Date.now() + 60_000) },
      { id: 's3', userId: 'u2', tokenId: 't3', expiresAt: new Date(Date.now() + 60_000) },
    ]);
    sessions.updateMany.mockResolvedValue({ count: 3 });

    const n = await service.revokeAllSessionsForUsers(['u1', 'u2']);

    expect(n).toBe(3);
    // filters only NOT-yet-revoked sessions of exactly these users
    expect(sessions.findMany).toHaveBeenCalledWith({
      where: { userId: { in: ['u1', 'u2'] }, revokedAt: null },
      select: { id: true, userId: true, tokenId: true, expiresAt: true },
    });
    // marks them revoked in bulk
    const updateArg = sessions.updateMany.mock.calls[0][0];
    expect(updateArg.where).toEqual({ userId: { in: ['u1', 'u2'] }, revokedAt: null });
    expect(updateArg.data.revokedAt).toBeInstanceOf(Date);
    // emits one revocation event per session, tagged as the org cascade
    expect(events.sessionRevoked).toHaveBeenCalledTimes(3);
    expect(events.sessionRevoked).toHaveBeenCalledWith('u1', 's1', 'org_deactivated');
    expect(events.sessionRevoked).toHaveBeenCalledWith('u2', 's3', 'org_deactivated');
  });

  it('dedups/cleans ids and short-circuits on empty input (no DB write)', async () => {
    const { service, sessions } = makeService();

    expect(await service.revokeAllSessionsForUsers([])).toBe(0);
    expect(await service.revokeAllSessionsForUsers(['', '  '])).toBe(0);
    expect(sessions.findMany).not.toHaveBeenCalled();
    expect(sessions.updateMany).not.toHaveBeenCalled();
  });

  it('returns 0 without an update when no live sessions exist', async () => {
    const { service, sessions, events } = makeService();
    sessions.findMany.mockResolvedValue([]);

    const n = await service.revokeAllSessionsForUsers(['u1', 'u1']);

    expect(n).toBe(0);
    expect(sessions.updateMany).not.toHaveBeenCalled();
    expect(events.sessionRevoked).not.toHaveBeenCalled();
    // duplicate ids collapse to a single entry
    expect(sessions.findMany).toHaveBeenCalledWith({
      where: { userId: { in: ['u1'] }, revokedAt: null },
      select: { id: true, userId: true, tokenId: true, expiresAt: true },
    });
  });
});
