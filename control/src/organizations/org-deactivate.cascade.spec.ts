import { OrganizationsService } from './organizations.service';
import type { PrismaService } from '../prisma/prisma.service';
import type { OrgAuditService } from './org-audit.service';
import type { OrgPdpService } from './org-pdp.service';
import type { UserDirectoryService } from '../user-directory/user-directory.service';

/**
 * P2.e (be-org-deactivate-cascade): OrganizationsService.setActive(false) must,
 * after the state flip commits, revoke the auth sessions of the org's ACTIVE
 * members via UserDirectoryService.revokeSessions. Reactivation must NOT trigger
 * the cascade. Fail-soft: a null result (auth down) does not throw / roll back.
 */
describe('OrganizationsService.setActive — deactivation cascade', () => {
  type Rec = Record<string, unknown>;

  function makeService(opts: {
    ownerUserId: string;
    activeMemberIds: string[];
    revokeResult?: number | null;
  }) {
    const auditRecord = jest.fn().mockResolvedValue(undefined);
    const revokeSessions = jest.fn().mockResolvedValue(opts.revokeResult ?? 0);

    const prisma = {
      systemSettings: {
        findUnique: jest.fn().mockResolvedValue({ id: 'org-1', isActive: true }),
      },
      employee: {
        findUnique: jest.fn(({ where }: { where: Rec }) => {
          const key = where.organizationId_userId as { userId: string };
          return Promise.resolve(
            key.userId === opts.ownerUserId ? { role: 'platform_owner' } : null,
          );
        }),
        findMany: jest.fn().mockResolvedValue(opts.activeMemberIds.map((userId) => ({ userId }))),
      },
      $transaction: jest.fn(async (fn: (tx: unknown) => Promise<unknown>) => {
        const tx = {
          systemSettings: {
            update: jest.fn(({ data }: { data: Rec }) => Promise.resolve({ id: 'org-1', ...data })),
          },
        };
        return fn(tx);
      }),
    } as unknown as PrismaService;

    const audit = { record: auditRecord } as unknown as OrgAuditService;
    const pdp = {} as unknown as OrgPdpService;
    const directory = { revokeSessions } as unknown as UserDirectoryService;

    const service = new OrganizationsService(prisma, audit, pdp, directory);
    return { service, prisma, revokeSessions };
  }

  it('revokes sessions of active members on deactivation', async () => {
    const { service, prisma, revokeSessions } = makeService({
      ownerUserId: 'owner',
      activeMemberIds: ['owner', 'emp-1', 'emp-2'],
      revokeResult: 3,
    });

    await service.setActive('org-1', false, 'owner');

    // only active employees queried
    expect(prisma.employee.findMany as jest.Mock).toHaveBeenCalledWith({
      where: { organizationId: 'org-1', isActive: true },
      select: { userId: true },
    });
    expect(revokeSessions).toHaveBeenCalledWith(['owner', 'emp-1', 'emp-2']);
  });

  it('does NOT revoke sessions on reactivation', async () => {
    const { service, revokeSessions } = makeService({
      ownerUserId: 'owner',
      activeMemberIds: ['owner'],
    });

    await service.setActive('org-1', true, 'owner');

    expect(revokeSessions).not.toHaveBeenCalled();
  });

  it('is fail-soft: deactivation succeeds even when auth is unreachable (null)', async () => {
    const { service, revokeSessions } = makeService({
      ownerUserId: 'owner',
      activeMemberIds: ['owner', 'emp-1'],
      revokeResult: null, // auth down / timeout
    });

    const res = await service.setActive('org-1', false, 'owner');

    expect(res.org.isActive).toBe(false);
    expect(revokeSessions).toHaveBeenCalledTimes(1);
  });

  it('skips the cascade call when the org has no active members', async () => {
    const { service, revokeSessions } = makeService({
      ownerUserId: 'owner',
      activeMemberIds: [],
    });

    await service.setActive('org-1', false, 'owner');

    expect(revokeSessions).not.toHaveBeenCalled();
  });
});
