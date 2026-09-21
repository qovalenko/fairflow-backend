import { SetMetadata } from '@nestjs/common';

export const MEMBERSHIP_ONLY_KEY = 'membershipOnly';

/**
 * TODO-056: explicit marker for project-scoped routes that intentionally require
 * only project membership (no `@RequirePermission` / `@RequireSystemRole`).
 * Unmarked project-scoped routes fail CI inventory and return 403 at runtime.
 */
export const MembershipOnly = () => SetMetadata(MEMBERSHIP_ONLY_KEY, true);
