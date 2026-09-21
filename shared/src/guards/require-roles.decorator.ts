import { SetMetadata } from '@nestjs/common';
import type { ProjectRole } from '../rbac';

export const REQUIRE_ROLES_KEY = 'requireProjectRole';

/**
 * Mark a gRPC handler as requiring at least `minRole` (project-role hierarchy).
 * Enforced by {@link GrpcRolesGuard} reading the trusted `x-roles` metadata.
 *
 * Use on Manager+ mutations (reopen / bulk / reassign / retry / accept-drift):
 *   @RequireRoles('manager')
 *
 * Fail-closed (SEC-BLOCKER, Д-2): a handler so annotated denies the call when
 * the propagated roles do not satisfy `minRole` — including the empty/absent
 * case (service actors without a user role context cannot pass a Manager+ gate).
 */
export const RequireRoles = (minRole: ProjectRole) =>
  SetMetadata(REQUIRE_ROLES_KEY, minRole);
