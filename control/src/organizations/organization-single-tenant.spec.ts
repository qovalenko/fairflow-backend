import { OrganizationsService } from './organizations.service';
import { AppError } from '@fairflow/shared';
import type { PrismaService } from '../prisma/prisma.service';
import type { OrgAuditService } from './org-audit.service';
import type { OrgPdpService } from './org-pdp.service';
import type { UserDirectoryService } from '../user-directory/user-directory.service';

/**
 * BX-FIX-2 (box single-tenant): OrganizationsService.create() must enforce the
 * "exactly one organization" invariant server-side. The first bootstrap creates
 * the org; any subsequent create — regardless of what the FE OrgSetupRecovery
 * guard allows — must fail-closed with a 'conflict' AppError (→ 409).
 */
describe('OrganizationsService.create — box single-tenant invariant', () => {
  function makeService(existingOrgCount: number) {
    const count = jest.fn().mockResolvedValue(existingOrgCount);
    const findUnique = jest.fn().mockResolvedValue(null);
    const orgCreate = jest.fn(({ data }: { data: Record<string, unknown> }) =>
      Promise.resolve({ id: 'org-1', ...data }),
    );

    const prisma = {
      systemSettings: { count, findUnique },
      $transaction: jest.fn(async (fn: (tx: unknown) => Promise<unknown>) => {
        const tx = {
          systemSettings: { create: orgCreate },
          employee: { create: jest.fn().mockResolvedValue({}) },
        };
        return fn(tx);
      }),
    } as unknown as PrismaService;

    const audit = { record: jest.fn() } as unknown as OrgAuditService;
    const pdp = {
      provisionOrgRoles: jest.fn().mockResolvedValue(undefined),
    } as unknown as OrgPdpService;
    const directory = {} as unknown as UserDirectoryService;

    const service = new OrganizationsService(prisma, audit, pdp, directory);
    return { service, count, orgCreate };
  }

  it('creates the first organization when none exists', async () => {
    const { service, orgCreate } = makeService(0);
    const result = await service.create({ name: 'Acme', userId: 'user-1' });
    expect(result.org.name).toBe('Acme');
    expect(orgCreate).toHaveBeenCalledTimes(1);
  });

  it('rejects a second organization with a conflict error', async () => {
    const { service, orgCreate } = makeService(1);
    await expect(service.create({ name: 'Beta', userId: 'user-2' })).rejects.toMatchObject({
      errorCode: 'conflict',
    });
    await expect(service.create({ name: 'Beta', userId: 'user-2' })).rejects.toBeInstanceOf(
      AppError,
    );
    expect(orgCreate).not.toHaveBeenCalled();
  });
});
