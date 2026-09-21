import { OrganizationsService } from './organizations.service';
import { AppError } from '@fairflow/shared';
import type { PrismaService } from '../prisma/prisma.service';
import type { OrgAuditService } from './org-audit.service';
import type { OrgPdpService } from './org-pdp.service';
import type { UserDirectoryService } from '../user-directory/user-directory.service';

describe('OrganizationsService access and reads', () => {
  function makeService(
    overrides: {
      org?: Record<string, unknown> | null;
      employee?: Record<string, unknown> | null;
      canManage?: boolean;
      rows?: Array<Record<string, unknown>>;
      system?: Record<string, unknown> | null;
    } = {},
  ) {
    const auditRecord = jest.fn().mockResolvedValue(undefined);
    const systemRow = overrides.system ?? { id: 'org-1', name: 'Acme', createdAt: new Date() };
    const prisma = {
      systemSettings: {
        findUnique: jest.fn(async ({ where }: { where: { id?: string } }) => {
          if (where.id && overrides.system === null) return null;
          if (where.id === systemRow.id || overrides.org === null) {
            return overrides.org === null ? null : systemRow;
          }
          return overrides.org ?? systemRow;
        }),
        findFirst: jest.fn().mockResolvedValue(overrides.system === null ? null : systemRow),
        update: jest.fn(({ data }: { data: Record<string, unknown> }) =>
          Promise.resolve({ id: 'org-1', ...data }),
        ),
      },
      employee: {
        findUnique: jest
          .fn()
          .mockResolvedValue(overrides.employee ?? { role: 'employee', isActive: true }),
        findMany: jest.fn().mockResolvedValue(overrides.rows ?? []),
      },
      $transaction: jest.fn(async (fn: (tx: unknown) => Promise<unknown>) =>
        fn({
          systemSettings: {
            update: jest.fn(({ data }: { data: Record<string, unknown> }) =>
              Promise.resolve({ id: 'org-1', ...data }),
            ),
          },
        }),
      ),
    } as unknown as PrismaService;
    const pdp = {
      canManage: jest.fn().mockResolvedValue(overrides.canManage ?? true),
    } as unknown as OrgPdpService;
    const audit = { record: auditRecord } as unknown as OrgAuditService;
    const directory = {} as unknown as UserDirectoryService;
    const service = new OrganizationsService(prisma, audit, pdp, directory);
    return { service, prisma, auditRecord, pdp };
  }

  it('get rejects unauthenticated callers', async () => {
    const { service } = makeService();
    await expect(service.get('org-1', '  ')).rejects.toMatchObject({
      errorCode: 'auth',
    } satisfies Partial<AppError>);
  });

  it('get rejects deactivated members', async () => {
    const { service } = makeService({ employee: { role: 'employee', isActive: false } });
    await expect(service.get('org-1', 'user-1')).rejects.toMatchObject({
      errorCode: 'access',
    });
  });

  it('get returns org and role for active members', async () => {
    const { service } = makeService({ employee: { role: 'platform_owner', isActive: true } });
    const result = await service.get('org-1', 'owner-1');
    expect(result.role).toBe('platform_owner');
    expect(result.org.id).toBe('org-1');
  });

  it('update requires profile-manage permission through PDP', async () => {
    const { service, pdp } = makeService({ canManage: false });
    await expect(service.update('org-1', { name: 'New' }, 'user-1')).rejects.toMatchObject({
      errorCode: 'access',
    });
    expect(pdp.canManage).toHaveBeenCalledWith('org-1', 'user-1', 'org:profile');
  });

  it('update persists allowed fields and writes audit fact', async () => {
    const { service, auditRecord } = makeService();
    const result = await service.update('org-1', { name: 'Renamed', phone: '+1' }, 'admin-1');
    expect(result.org.name).toBe('Renamed');
    expect(auditRecord).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'organization.updated',
        entityType: 'organization',
        metadata: { fields: ['name', 'phone'] },
      }),
      expect.anything(),
    );
  });

  it('listMy returns empty for blank userId', async () => {
    const { service } = makeService();
    await expect(service.listMy('')).resolves.toEqual([]);
  });

  it('listMy maps active memberships to the singleton system org', async () => {
    const { service } = makeService({
      rows: [
        { organizationId: 'org-1', role: 'employee', isActive: true },
        { organizationId: 'org-1', role: 'employee', isActive: false },
      ],
      system: { id: 'org-1', name: 'System', slug: 'system' },
    });
    await expect(service.listMy('user-1')).resolves.toEqual([
      { id: 'org-1', name: 'System', slug: 'system', role: 'employee' },
    ]);
  });

  it('resolveSystemAnchorId fails before bootstrap', async () => {
    const { service } = makeService({ system: null });
    await expect(service.resolveSystemAnchorId()).rejects.toMatchObject({
      errorCode: 'access',
    });
  });

  it('resolveSystemAnchorId returns the singleton system id', async () => {
    const { service } = makeService({ system: { id: 'sys-1' } });
    await expect(service.resolveSystemAnchorId()).resolves.toBe('sys-1');
  });
});
