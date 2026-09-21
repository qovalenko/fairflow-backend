import { SetMetadata } from '@nestjs/common';
import type { PermissionAction } from '@fairflow/shared';

export const REQUIRED_PERMISSION_KEY = 'requiredPermission';

export type RequiredPermission = { subject: string; action: PermissionAction };

/**
 * Require permission to perform `action` on `subject` in the current project.
 *
 * Enforced by ProjectAccessGuard in TWO steps (TODO-027):
 *  1. flat role×action matrix (`projectRoleCanKey`, @fairflow/shared) — a cheap
 *     local pre-filter that can deny without a network call;
 *  2. control's PDP (`RoleGrpc.CheckPermissions` → `decideRbac`) — the
 *     authoritative verdict over the project's permission catalog: custom roles,
 *     department/unit role assignments and addressed `PermissionGrant`s
 *     (deny > allow). Fail-closed: no decision ⇒ 403.
 *
 * So `subject` is load-bearing: it is resolved to catalog key(s) via
 * `resolveDecoratorPermission` (FR-PERM-25) — keep new pairs in lock-step with
 * the module manifests' `policyCapabilities`, or the pair carries no granular
 * opinion at all (`NO_CATALOG_KEY`) and only the flat matrix applies.
 */
export const RequirePermission = (subject: string, action: PermissionAction) =>
  SetMetadata(REQUIRED_PERMISSION_KEY, { subject, action } satisfies RequiredPermission);
