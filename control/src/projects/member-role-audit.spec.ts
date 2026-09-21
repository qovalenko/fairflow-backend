import { ProjectsService } from './projects.service';
import { PrismaService } from '../prisma/prisma.service';
import { ProjectProvisioningService } from '../provisioning/project-provisioning.service';
import { AutomationLifecycleService } from '../provisioning/automation-lifecycle.service';
import { ControlEventEmitter } from '../outbox/control-event.emitter';
import { RoleAuditService, type RoleAuditEntry } from '../outbox/role-audit.service';
import { MemberOwnedRecordsService } from './member-owned-records.service';
import { AppError } from '@fairflow/shared';

/**
 * S6 ("silent role change" fix): a project-member role write MUST persist an
 * audit row + emit an outbox event in the SAME transaction, and a rejected
 * mutation (LAST_OWNER) must emit nothing. These are unit tests over a fake
 * Prisma whose `$transaction` runs the callback against the same client, so the
 * audit append receives exactly the transaction client the mutation used.
 */
describe('ProjectsService member-role audit (S6)', () => {
  const PROJECT = 'proj-1';

  type MemberRow = { id: string; projectId: string; userId: string; role: string };

  function build(
    members: MemberRow[],
    ownersCount = members.filter((m) => m.role === 'owner').length,
  ) {
    const find = (userId: string): MemberRow | null =>
      members.find((m) => m.userId === userId) ?? null;
    const prisma = {
      projectMember: {
        findUnique: jest.fn(
          async ({ where }: { where: { projectId_userId: { userId: string } } }) =>
            find(where.projectId_userId.userId),
        ),
        count: jest.fn(async () => ownersCount),
        update: jest.fn(async ({ data }: { data: { role: string } }) => ({
          ...find('target-1')!,
          role: data.role,
        })),
        upsert: jest.fn(async ({ create }: { create: MemberRow }) => create),
        deleteMany: jest.fn(async () => ({ count: 1 })),
      },
      project: { findUnique: jest.fn(async () => ({ id: PROJECT, members: [] })) },
      $transaction: jest.fn(),
    };
    // Run the mutation callback against the same fake so the audit append sees the tx.
    prisma.$transaction.mockImplementation(async (cb: (tx: unknown) => unknown) => cb(prisma));
    const roleAudit = {
      append: jest.fn().mockResolvedValue('audit-1'),
    } as unknown as RoleAuditService;
    const events = { emit: jest.fn() } as unknown as ControlEventEmitter;
    const provisioning = {} as ProjectProvisioningService;
    const automationLifecycle = {
      syncModuleTransitions: jest.fn(),
      syncArchiveTransition: jest.fn(),
    } as unknown as AutomationLifecycleService;
    const ownedRecords = {
      countOwned: jest.fn().mockResolvedValue({ total: 0, breakdown: [] }),
      reassignOwned: jest.fn(),
    } as unknown as MemberOwnedRecordsService;
    const service = new ProjectsService(
      prisma as unknown as PrismaService,
      provisioning,
      automationLifecycle,
      events,
      roleAudit,
      ownedRecords,
    );
    return { service, prisma, roleAudit };
  }

  it('updateMemberRole writes an audit line + event in the mutation tx', async () => {
    const { service, prisma, roleAudit } = build([
      { id: 'm-actor', projectId: PROJECT, userId: 'actor-1', role: 'owner' },
      { id: 'm-target', projectId: PROJECT, userId: 'target-1', role: 'member' },
    ]);
    await service.updateMemberRole(PROJECT, 'target-1', 'admin', 'actor-1');

    expect(prisma.projectMember.update).toHaveBeenCalled();
    expect(roleAudit.append).toHaveBeenCalledTimes(1);
    const [tx, entry] = (roleAudit.append as jest.Mock).mock.calls[0] as [unknown, RoleAuditEntry];
    // audit ran against the SAME client the mutation used (same tx).
    expect(tx).toBe(prisma);
    expect(entry).toMatchObject({
      projectId: PROJECT,
      actorUserId: 'actor-1',
      action: 'member_role.changed',
      entityType: 'project_member',
      entityId: 'm-target',
      before: { userId: 'target-1', role: 'member' },
      after: { userId: 'target-1', role: 'admin' },
    });
  });

  it('updateMemberRole rejects the last-owner demote and emits NO audit/event', async () => {
    const { service, roleAudit } = build(
      [
        { id: 'm-actor', projectId: PROJECT, userId: 'actor-1', role: 'owner' },
        { id: 'm-owner', projectId: PROJECT, userId: 'owner-1', role: 'owner' },
      ],
      1, // only one owner in the project → demote is blocked
    );
    await expect(service.updateMemberRole(PROJECT, 'owner-1', 'member', 'actor-1')).rejects.toThrow(
      AppError,
    );
    expect(roleAudit.append).not.toHaveBeenCalled();
  });

  it('addMember audits with action member.added', async () => {
    const { service, roleAudit } = build([
      { id: 'm-actor', projectId: PROJECT, userId: 'actor-1', role: 'owner' },
    ]);
    await service.addMember(PROJECT, 'new-1', 'member', 'actor-1');
    const [, entry] = (roleAudit.append as jest.Mock).mock.calls[0] as [unknown, RoleAuditEntry];
    expect(entry).toMatchObject({
      projectId: PROJECT,
      action: 'member.added',
      entityType: 'project_member',
      after: { userId: 'new-1', role: 'member' },
    });
  });

  it('removeMember audits with action member.removed', async () => {
    const { service, roleAudit } = build(
      [
        { id: 'm-actor', projectId: PROJECT, userId: 'actor-1', role: 'owner' },
        { id: 'm-target', projectId: PROJECT, userId: 'target-1', role: 'member' },
      ],
      2,
    );
    await service.removeMember(PROJECT, 'target-1', 'actor-1');
    const [, entry] = (roleAudit.append as jest.Mock).mock.calls[0] as [unknown, RoleAuditEntry];
    expect(entry).toMatchObject({
      projectId: PROJECT,
      action: 'member.removed',
      entityType: 'project_member',
      before: { userId: 'target-1', role: 'member' },
      after: null,
    });
  });
});
