import { InvitationService } from './invitations.service';

describe('InvitationService.accept idempotency (NFR-AUTH-070)', () => {
  it('returns success when the same user accepts an already-accepted invite', async () => {
    const invitation = {
      id: 'inv-1',
      organizationId: 'org-1',
      status: 'accepted',
      acceptedUserId: 'user-1',
      projectGrants: [{ projectId: 'p1', role: 'member' }],
      expiresAt: new Date(Date.now() + 60_000),
      role: 'employee',
      email: 'a@x.com',
    };
    const prisma = {
      invitation: {
        findUnique: jest.fn().mockResolvedValue(invitation),
      },
    };
    const svc = new InvitationService(
      prisma as never,
      { record: jest.fn() } as never,
      { ensureSystemOrgRoles: jest.fn() } as never,
      { syncMemberDepartmentBinding: jest.fn() } as never,
      { bumpForProjects: jest.fn() } as never,
    );

    await expect(svc.accept('opaque-token', 'user-1')).resolves.toEqual({
      organizationId: 'org-1',
      userId: 'user-1',
      projectGrants: [{ projectId: 'p1', role: 'member' }],
    });
  });
});
