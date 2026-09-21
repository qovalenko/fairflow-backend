import { InvitationService } from './invitations.service';
import { OrgAuditService } from './org-audit.service';
import { OrgPdpService } from './org-pdp.service';
import { PrismaService } from '../prisma/prisma.service';

/**
 * FR-ORG-420: lazy expiry marking on list/getByToken.
 */
describe('InvitationService lazy expiry (FR-ORG-420)', () => {
  const orgId = 'org-1';
  const stale = {
    id: 'inv-stale',
    organizationId: orgId,
    email: 'old@example.com',
    status: 'pending',
    expiresAt: new Date(Date.now() - 60_000),
    role: 'employee',
    token: 'hash',
  };

  function makeService() {
    const updateMany = jest.fn().mockResolvedValue({ count: 1 });
    const update = jest.fn().mockResolvedValue({ ...stale, status: 'expired' });
    const findMany = jest.fn().mockResolvedValue([{ ...stale, status: 'expired' }]);
    const prisma = {
      invitation: { updateMany, update, findMany },
    } as unknown as PrismaService;
    const svc = new InvitationService(
      prisma,
      {} as OrgAuditService,
      {} as OrgPdpService,
      {
        bindingMembershipAddEmployee: jest.fn(),
        bindingMembershipRemoveEmployee: jest.fn(),
      } as never,
      { bump: jest.fn() } as never,
    );
    jest
      .spyOn(svc as never as { assertCanManage: () => Promise<void> }, 'assertCanManage')
      .mockResolvedValue();
    jest
      .spyOn(svc as never as { resolveByToken: () => Promise<typeof stale> }, 'resolveByToken')
      .mockResolvedValue(stale);
    return { svc, updateMany, update, findMany };
  }

  it('list() marks stale pending invites as expired before returning', async () => {
    const { svc, updateMany } = makeService();
    await svc.list(orgId, 'admin');
    expect(updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ organizationId: orgId, status: 'pending' }),
        data: { status: 'expired' },
      }),
    );
  });

  it('getByToken() marks stale pending invite expired and rejects', async () => {
    const { svc, update } = makeService();
    await expect(svc.getByToken('token')).rejects.toThrow('Invitation has expired');
    expect(update).toHaveBeenCalledWith({
      where: { id: stale.id },
      data: { status: 'expired' },
    });
  });
});
