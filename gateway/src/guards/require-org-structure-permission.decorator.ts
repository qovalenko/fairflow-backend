import { SetMetadata } from '@nestjs/common';
import type { PermissionAction } from '@fairflow/shared';

export const REQUIRED_ORG_STRUCTURE_PERMISSION_KEY = 'requiredOrgStructurePermission';

export type RequiredOrgStructurePermission = { subject: string; action: PermissionAction };

/**
 * Require an org-structure permission (`org:*` subject) on a system-scoped route
 * (FR-ORG-740, defense-in-depth over control's OrgPdpService).
 *
 * Enforced by SystemAccessGuard as a SECOND layer after `@RequireSystemRole`:
 * the guard resolves the caller's effective org-structure allow-set via
 * `OrganizationGrpc.GetOrgPermissionProjection` and fail-closed denies when the
 * required `subject:action` key is absent.
 *
 * Keep subjects in lock-step with `ORG_STRUCTURE_SUBJECTS` (@fairflow/shared).
 */
export const RequireOrgStructurePermission = (subject: string, action: PermissionAction) =>
  SetMetadata(REQUIRED_ORG_STRUCTURE_PERMISSION_KEY, {
    subject,
    action,
  } satisfies RequiredOrgStructurePermission);
