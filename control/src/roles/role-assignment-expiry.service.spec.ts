import { RoleAssignmentExpiryService } from './role-assignment-expiry.service';

describe('RoleAssignmentExpiryService (FR-ACCESS-650)', () => {
  it('emits control.role.assignment.expiring for assignments inside warn window', async () => {
    const expiresAt = new Date(Date.now() + 2 * 24 * 60 * 60 * 1000);
    const prisma = {
      roleAssignment: {
        findMany: jest.fn().mockResolvedValue([
          {
            id: 'ra1',
            projectId: 'p1',
            subjectId: 'u1',
            roleId: 'r1',
            expiresAt,
          },
        ]),
      },
      $transaction: jest.fn(async (fn: (tx: unknown) => Promise<void>) => fn({})),
    };
    const events = { emit: jest.fn().mockResolvedValue(undefined) };
    const svc = new RoleAssignmentExpiryService(prisma as never, events as never);
    const n = await svc.emitExpiring();
    expect(n).toBe(1);
    expect(events.emit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        routingKey: 'control.role.assignment.expiring',
        metadata: expect.objectContaining({ assignmentId: 'ra1', userId: 'u1' }),
      }),
    );
  });
});
