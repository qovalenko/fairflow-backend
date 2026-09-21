/**
 * P8 T5.2 (X-10) — map a control audit fact `(action, entityType)` onto its
 * canonical bus routing-key (RFC-4 §Р-3, registered in `@fairflow/shared`).
 *
 * Control has two central audit writers — `OrgAuditService.record` (org struct)
 * and `RolesService.audit` (project/org RBAC) — plus the project module-policy
 * update. Every rights/org/policy mutation already funnels through one of these,
 * so mapping their `action` here gives every fact a single, complete emit point
 * without touching 20+ call-sites (minimal change, X-4: no global EventEnvelope).
 *
 * Anything not mapped returns `undefined` → NO event is emitted (fail-safe: an
 * un-mapped fact never enters the outbox with an illegal key). New audit actions
 * MUST be added here (and their key registered) to reach the audit chain.
 */

/** Routing-key for an OrgAuditLog fact, or undefined if the action is not emitted. */
export function orgAuditRoutingKey(action: string, entityType: string): string | undefined {
  // Employee / membership lifecycle → control.member.*
  if (entityType === 'employee') {
    if (action === 'employee.added') return 'control.member.added';
    if (action === 'employee.removed') return 'control.member.removed';
    // updated / deactivated / reactivated are all membership state changes.
    return 'control.member.changed';
  }
  // Department + AccessUnit (the org grouping primitive) → control.department.changed
  if (
    entityType === 'department' ||
    entityType === 'access_unit' ||
    entityType === 'access_unit_member' ||
    entityType === 'access_unit_composition'
  ) {
    return 'control.department.changed';
  }
  // Department→project binding lifecycle → control.binding.changed (created /
  // changed / deleted all share the key; the action carries the specific fact).
  if (entityType === 'department_binding') {
    return 'control.binding.changed';
  }
  // Invitation lifecycle → control.invitation.*
  if (entityType === 'invitation') {
    if (action === 'invitation.created') return 'control.invitation.created';
    if (action === 'invitation.accepted') return 'control.invitation.accepted';
    // revoked + resent are both "the pending invite changed" → revoked bucket.
    return 'control.invitation.revoked';
  }
  // Organization lifecycle. Deactivation carries an access cascade (session
  // revocation + downstream consumers) so it gets a dedicated key; profile edits
  // and reactivation stay on the generic control.org.changed.
  if (entityType === 'organization') {
    if (action === 'organization.deactivated') return 'control.org.deactivated';
    return 'control.org.changed';
  }
  // Record sharing (visibility widening) → control.record.*
  if (entityType === 'record_share') {
    if (action === 'record.unshared') return 'control.record.unshared';
    return 'control.record.shared';
  }
  // Visibility policy change → control.visibility.changed
  if (entityType === 'visibility_config') return 'control.visibility.changed';
  return undefined;
}

/** Routing-key for a RoleAuditLog fact, or undefined if the action is not emitted. */
export function roleAuditRoutingKey(action: string, entityType: string): string | undefined {
  if (entityType === 'role') return 'control.role.changed';
  if (entityType === 'role_assignment') {
    if (action === 'assignment.revoked') return 'control.role.revoked';
    return 'control.role.assigned';
  }
  // Project-membership role changes (S6 "silent role change" fix). A member's
  // project role is a role assignment to a user, so it reuses the RBAC role keys:
  // add/change → control.role.assigned, remove → control.role.revoked. RFC-4:
  // control.role.assigned = "role assigned to a participant" — exactly this case.
  if (entityType === 'project_member') {
    if (action === 'member.removed') return 'control.role.revoked';
    return 'control.role.assigned';
  }
  if (entityType === 'permission_grant') return 'control.grant.changed';
  return undefined;
}
