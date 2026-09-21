import { SetMetadata } from '@nestjs/common';

export const REQUIRED_SYSTEM_ROLE_KEY = 'requiredSystemRole';

/**
 * System-level access requirement for a gateway route (DEORG-GW-4, ex-@RequireOrgRole).
 *
 *  - `'owner'` — the caller must be the platform_owner (owner-only actions such as
 *    org deactivate/reactivate; control enforces the same — FR-ORG-040).
 *  - `'manage'` — the caller must be a system owner/admin (`orgRoleCanManage`).
 *    Applied to every system MUTATION (employees, departments, invitations,
 *    requisites), symmetric to `@RequirePermission(..,'manage')` on project routes.
 *  - `'member'` — the caller must be ANY active employee of the system. Applied to
 *    system STRUCTURE reads (employees/departments/audit/invitations list).
 *
 * We name the axis "system role" (not "system permission") deliberately: v1 system
 * access is still role-based (three system roles, one `orgRoleCanManage` gate).
 * The role literals (`platform_*`) are unchanged in the DB (box SINGLETON strategy,
 * FR-DEORG-5) — only the code/UI vocabulary de-orgs.
 *
 * Enforced by SystemAccessGuard, which resolves the caller's Employee role from
 * control (epoch-less TTL cache). box de-orgification (DEORG-GW-5) stripped `:orgId`
 * from the routes; control resolves the singleton itself (DEORG-BE-16).
 */
export type SystemRoleRequirement = 'owner' | 'manage' | 'member';

export const RequireSystemRole = (requirement: SystemRoleRequirement) =>
  SetMetadata(REQUIRED_SYSTEM_ROLE_KEY, requirement);
