import { RoleAuditService } from './role-audit.service';
import type { ControlEventEmitter } from './control-event.emitter';

describe('RoleAuditService.append', () => {
  let events: { emit: jest.Mock };
  let tx: {
    $executeRaw: jest.Mock;
    roleAuditLog: {
      findFirst: jest.Mock;
      create: jest.Mock;
    };
  };
  let service: RoleAuditService;

  beforeEach(() => {
    events = { emit: jest.fn().mockResolvedValue(undefined) };
    tx = {
      $executeRaw: jest.fn().mockResolvedValue(undefined),
      roleAuditLog: {
        findFirst: jest.fn().mockResolvedValue({ chainHash: 'prev-hash' }),
        create: jest.fn().mockResolvedValue({}),
      },
    };
    service = new RoleAuditService(events as unknown as ControlEventEmitter);
  });

  it('writes a chained audit row and emits the mapped routing key', async () => {
    const auditId = await service.append(tx as never, {
      projectId: 'proj-1',
      actorUserId: 'admin',
      action: 'role.created',
      entityType: 'role',
      entityId: 'role-1',
      summary: 'created Sales',
      before: null,
      after: { name: 'Sales', permissions: ['deals:read'] },
    });

    expect(tx.$executeRaw).toHaveBeenCalled();
    expect(tx.roleAuditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          projectId: 'proj-1',
          action: 'role.created',
          entityType: 'role',
          prevHash: 'prev-hash',
          chainHash: expect.any(String),
        }),
      }),
    );
    expect(events.emit).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({
        routingKey: 'control.role.changed',
        idempotencyKey: auditId,
        projectId: 'proj-1',
        metadata: expect.objectContaining({
          permissionDiff: expect.objectContaining({ added: ['deals:read'] }),
        }),
      }),
    );
  });

  it('uses an explicit routing key for project-member facts', async () => {
    await service.append(tx as never, {
      projectId: 'proj-1',
      actorUserId: 'admin',
      action: 'member_role.changed',
      entityType: 'project_member',
      routingKey: 'control.role.assigned',
      before: { userId: 'u1', role: 'member' },
      after: { userId: 'u1', role: 'manager' },
    });

    expect(events.emit).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({
        routingKey: 'control.role.assigned',
        payloadFields: expect.objectContaining({
          subjectUserId: 'u1',
          role: 'manager',
          previousRole: 'member',
        }),
      }),
    );
  });

  it('does not emit when the action has no bus mapping and no override', async () => {
    await service.append(tx as never, {
      orgId: 'org-1',
      actorUserId: 'admin',
      action: 'unknown.action',
      entityType: 'unknown',
    });
    expect(events.emit).not.toHaveBeenCalled();
  });
});
