import { isRegisteredRoutingKey } from '@fairflow/shared';
import { orgAuditRoutingKey, roleAuditRoutingKey } from './control-event-map';
import { ControlEventEmitter } from './control-event.emitter';
import { ControlOutboxStore } from './control-outbox.store';

/** Shape of an outbox row as the store receives it (subset the tests assert). */
interface CapturedRow {
  messageId: string;
  routingKey: string;
  projectId?: string;
  status: string;
  envelope: {
    type: string;
    source: string;
    idempotencyKey: string;
    userId?: string;
    actorType?: string;
    subject?: string;
    payload: Record<string, unknown>;
  };
}

/**
 * P8 T5.2 (X-10): control → bus → audit. These unit tests pin
 *  (1) every rights/org/policy audit fact maps to a REGISTERED routing-key
 *      (no event silently lost on the way to the audit chain), and
 *  (2) the emitter writes exactly one outbox row per fact with a stable
 *      idempotencyKey (so an at-least-once re-publish never doubles the chain).
 */
describe('control event map (audit fact → routing-key)', () => {
  // Every group the acceptance criteria requires a path for.
  const orgCases: Array<[string, string, string]> = [
    // [action, entityType, expected routing-key]
    ['employee.added', 'employee', 'control.member.added'],
    ['employee.updated', 'employee', 'control.member.changed'],
    ['employee.deactivated', 'employee', 'control.member.changed'],
    ['employee.reactivated', 'employee', 'control.member.changed'],
    ['employee.removed', 'employee', 'control.member.removed'],
    ['department.created', 'department', 'control.department.changed'],
    ['department.updated', 'department', 'control.department.changed'],
    ['department.deleted', 'department', 'control.department.changed'],
    ['unit.created', 'access_unit', 'control.department.changed'],
    ['unit.member_added', 'access_unit_member', 'control.department.changed'],
    ['unit.composed', 'access_unit_composition', 'control.department.changed'],
    ['invitation.created', 'invitation', 'control.invitation.created'],
    ['invitation.revoked', 'invitation', 'control.invitation.revoked'],
    ['invitation.resent', 'invitation', 'control.invitation.revoked'],
    ['invitation.accepted', 'invitation', 'control.invitation.accepted'],
    ['organization.updated', 'organization', 'control.org.changed'],
    // Deactivation is the only org action that carries the access cascade → its
    // own key; everything else (edit/reactivate) stays on control.org.changed.
    ['organization.deactivated', 'organization', 'control.org.deactivated'],
    ['organization.reactivated', 'organization', 'control.org.changed'],
    ['record.shared', 'record_share', 'control.record.shared'],
    ['record.unshared', 'record_share', 'control.record.unshared'],
    ['visibility.updated', 'visibility_config', 'control.visibility.changed'],
  ];

  it.each(orgCases)('org %s/%s → %s', (action, entityType, key) => {
    const resolved = orgAuditRoutingKey(action, entityType);
    expect(resolved).toBe(key);
    expect(isRegisteredRoutingKey(resolved!)).toBe(true);
  });

  const roleCases: Array<[string, string, string]> = [
    ['role.created', 'role', 'control.role.changed'],
    ['role.updated', 'role', 'control.role.changed'],
    ['role.deleted', 'role', 'control.role.changed'],
    ['assignment.granted', 'role_assignment', 'control.role.assigned'],
    ['assignment.revoked', 'role_assignment', 'control.role.revoked'],
    ['grant.created', 'permission_grant', 'control.grant.changed'],
    ['grant.deleted', 'permission_grant', 'control.grant.changed'],
    // S6: project-member role facts reuse the RBAC role keys.
    ['member.added', 'project_member', 'control.role.assigned'],
    ['member_role.changed', 'project_member', 'control.role.assigned'],
    ['member.removed', 'project_member', 'control.role.revoked'],
  ];

  it.each(roleCases)('role %s/%s → %s', (action, entityType, key) => {
    const resolved = roleAuditRoutingKey(action, entityType);
    expect(resolved).toBe(key);
    expect(isRegisteredRoutingKey(resolved!)).toBe(true);
  });

  it('module-policy uses the registered control.policy.updated key', () => {
    expect(isRegisteredRoutingKey('control.policy.updated')).toBe(true);
  });

  // BX-MODEL-6 (§7.3): access-preset / share / visibility facts are chained via
  // explicit routing-keys on RoleAuditService.append; all three must be registered
  // or ControlEventEmitter silently drops the outbox emit.
  it('access-preset / share / visibility facts use registered keys', () => {
    expect(isRegisteredRoutingKey('control.preset.applied')).toBe(true);
    expect(isRegisteredRoutingKey('control.record.shared')).toBe(true);
    expect(isRegisteredRoutingKey('control.record.unshared')).toBe(true);
    expect(isRegisteredRoutingKey('control.visibility.changed')).toBe(true);
  });

  it('an unknown fact maps to undefined (never an illegal emit)', () => {
    expect(orgAuditRoutingKey('mystery.happened', 'mystery')).toBeUndefined();
    expect(roleAuditRoutingKey('mystery.happened', 'mystery')).toBeUndefined();
  });
});

describe('ControlEventEmitter (outbox row build + insert)', () => {
  function makeEmitter() {
    const inserted: Array<{ tx: unknown; row: CapturedRow }> = [];
    const store = {
      insertRow: jest.fn(async (tx: unknown, row: unknown) => {
        inserted.push({ tx, row: row as CapturedRow });
      }),
    } as unknown as ControlOutboxStore;
    const emitter = new ControlEventEmitter(store);
    return { emitter, store, inserted };
  }

  const tx = { marker: 'tx' } as unknown as Parameters<ControlEventEmitter['emit']>[0];

  it('builds a valid envelope and inserts one row in the caller tx', async () => {
    const { emitter, store, inserted } = makeEmitter();
    await emitter.emit(tx, {
      routingKey: 'control.member.added',
      idempotencyKey: 'audit-1',
      organizationId: 'org-1',
      actorUserId: 'actor-1',
      entityType: 'employee',
      entityId: 'emp-9',
      action: 'employee.added',
      metadata: { role: 'employee' },
    });
    expect(store.insertRow).toHaveBeenCalledTimes(1);
    const { tx: passedTx, row } = inserted[0];
    // written inside the caller's transaction
    expect(passedTx).toBe(tx);
    expect(row.routingKey).toBe('control.member.added');
    expect(row.status).toBe('pending');
    expect(row.envelope.type).toBe('control.member.added');
    expect(row.envelope.source).toBe('control');
    // stable idempotencyKey → at-least-once dedup on the consumer
    expect(row.envelope.idempotencyKey).toBe('audit-1');
    expect(row.envelope.userId).toBe('actor-1');
    expect(row.envelope.actorType).toBe('user');
    expect(row.envelope.subject).toBe('employee/emp-9');
    expect(row.envelope.payload.action).toBe('employee.added');
    expect(row.envelope.payload.organizationId).toBe('org-1');
  });

  it('system actor when no user id is present', async () => {
    const { emitter, inserted } = makeEmitter();
    await emitter.emit(tx, {
      routingKey: 'control.department.changed',
      idempotencyKey: 'audit-2',
      organizationId: 'org-1',
      actorUserId: null,
      entityType: 'department',
      entityId: 'dep-1',
      action: 'department.created',
    });
    expect(inserted[0].row.envelope.actorType).toBe('system');
  });

  it('skips (no insert) for an unregistered routing-key', async () => {
    const { emitter, store } = makeEmitter();
    await emitter.emit(tx, {
      routingKey: 'control.not_a_real.key',
      idempotencyKey: 'audit-3',
      entityType: 'x',
      action: 'x.y',
    });
    expect(store.insertRow).not.toHaveBeenCalled();
  });

  it('re-emitting the same fact yields the SAME idempotencyKey (dedup contract)', async () => {
    const { emitter, inserted } = makeEmitter();
    const input = {
      routingKey: 'control.role.assigned',
      idempotencyKey: 'audit-42',
      projectId: 'proj-1',
      actorUserId: 'a1',
      entityType: 'role_assignment',
      entityId: 'ra-1',
      action: 'assignment.granted',
    };
    await emitter.emit(tx, input);
    await emitter.emit(tx, input);
    const keys = inserted.map((i) => i.row.envelope.idempotencyKey);
    expect(keys).toEqual(['audit-42', 'audit-42']);
  });
});
