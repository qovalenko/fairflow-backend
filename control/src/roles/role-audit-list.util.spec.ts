import {
  buildRoleAuditWhere,
  diffPermissionKeySets,
  encodeRoleAuditCursor,
  parseRoleAuditCursor,
} from './role-audit-list.util';

describe('role-audit-list.util (FR-ACCESS-610/640)', () => {
  it('round-trips opaque cursor', () => {
    const createdAt = new Date('2026-08-20T10:00:00.000Z');
    const cursor = encodeRoleAuditCursor(createdAt, 'audit-1');
    expect(parseRoleAuditCursor(cursor)).toEqual({ createdAt, id: 'audit-1' });
  });

  it('builds filter where-clause', () => {
    const where = buildRoleAuditWhere({
      projectId: 'proj-1',
      filterActorUserId: 'user-a',
      filterEntityType: 'role',
      fromTs: new Date('2026-08-01'),
    });
    expect(where).toMatchObject({
      projectId: 'proj-1',
      actorUserId: 'user-a',
      entityType: 'role',
      createdAt: { gte: new Date('2026-08-01') },
    });
  });

  it('diffs permission arrays from audit payloads', () => {
    const diff = diffPermissionKeySets(
      { permissions: ['deals:read', 'deals:write'] },
      { permissions: ['deals:read', 'contacts:read'] },
    );
    expect(diff).toEqual({ added: ['contacts:read'], removed: ['deals:write'] });
  });
});
