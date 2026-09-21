import { RecordSharesService } from './record-shares.service';
import { AppError } from '@fairflow/shared';

function makeService(seed: {
  members?: Array<{ projectId: string; userId: string; role: string }>;
  shares?: Array<Record<string, unknown>>;
}) {
  const members = seed.members ?? [];
  const shares = seed.shares ?? [];
  const prisma = {
    projectMember: {
      findUnique: ({
        where,
      }: {
        where: { projectId_userId: { projectId: string; userId: string } };
      }) =>
        Promise.resolve(
          members.find(
            (m) =>
              m.projectId === where.projectId_userId.projectId &&
              m.userId === where.projectId_userId.userId,
          ) ?? null,
        ),
    },
    recordShare: {
      findFirst: ({ where }: { where: { id: string; projectId: string } }) =>
        Promise.resolve(
          shares.find((s) => s.id === where.id && s.projectId === where.projectId) ?? null,
        ),
      deleteMany: () => Promise.resolve({ count: 1 }),
    },
    $transaction: async (fn: (tx: unknown) => Promise<unknown>) =>
      fn({
        recordShare: {
          upsert: () => Promise.resolve({ id: 'share-1' }),
          deleteMany: () => Promise.resolve({ count: 1 }),
        },
      }),
  };
  const roleAudit = { append: jest.fn() };
  return {
    service: new RecordSharesService(prisma as never, roleAudit as never),
    roleAudit,
  };
}

describe('RecordSharesService (FR-ACCESS-400/420)', () => {
  it('allows manager to share without manage rights', async () => {
    const { service } = makeService({
      members: [{ projectId: 'p1', userId: 'mgr', role: 'manager' }],
    });
    await expect(
      service.share('p1', 'contacts', 'c1', 'user', 'u2', 'mgr', null, 'other'),
    ).resolves.toBeDefined();
  });

  it('allows record owner to share', async () => {
    const { service } = makeService({
      members: [{ projectId: 'p1', userId: 'owner-user', role: 'member' }],
    });
    await expect(
      service.share('p1', 'contacts', 'c1', 'user', 'u2', 'owner-user', null, 'owner-user'),
    ).resolves.toBeDefined();
  });

  it('denies member who is not the record owner', async () => {
    const { service } = makeService({
      members: [{ projectId: 'p1', userId: 'mem', role: 'member' }],
    });
    await expect(
      service.share('p1', 'contacts', 'c1', 'user', 'u2', 'mem', null, 'other'),
    ).rejects.toBeInstanceOf(AppError);
  });

  it('allows manager to revoke a share created by a departed member', async () => {
    const { service } = makeService({
      members: [{ projectId: 'p1', userId: 'mgr', role: 'manager' }],
      shares: [
        {
          id: 's2',
          projectId: 'p1',
          resource: 'contacts',
          recordId: 'c1',
          granteeType: 'user',
          granteeId: 'u2',
          createdBy: 'gone',
        },
      ],
    });
    await expect(service.unshare('s2', 'p1', 'mgr')).resolves.toEqual({ ok: true });
  });

  it('allows manager to revoke a subordinate share', async () => {
    const { service } = makeService({
      members: [
        { projectId: 'p1', userId: 'mgr', role: 'manager' },
        { projectId: 'p1', userId: 'mem', role: 'member' },
      ],
      shares: [
        {
          id: 's1',
          projectId: 'p1',
          resource: 'contacts',
          recordId: 'c1',
          granteeType: 'user',
          granteeId: 'u2',
          createdBy: 'mem',
        },
      ],
    });
    await expect(service.unshare('s1', 'p1', 'mgr')).resolves.toEqual({ ok: true });
  });
});
