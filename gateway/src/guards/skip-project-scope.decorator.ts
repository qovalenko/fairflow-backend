import { SetMetadata } from '@nestjs/common';

export const SKIP_PROJECT_SCOPE_KEY = 'skipProjectScope';

/**
 * Marks a route as having NO current-project context, so ProjectAccessGuard must
 * NOT derive the target projectId from the ambient `x-project-id` request header.
 *
 * Motivation (T-001-BE): routes that CREATE a new project — or otherwise operate
 * outside any single project (e.g. onboarding provisioning) — have no existing
 * project to scope against. The client still sends `x-project-id` for the user's
 * currently-open project (which may be stale or belong to someone else), and the
 * guard would otherwise resolve the caller's membership in THAT unrelated project
 * and 403 (PROJECT_ACCESS_DENIED) — semantically wrong for a create-new operation.
 *
 * With this marker the guard ignores the header; an explicit `:projectId` path
 * param (or `?projectId=` query) — if a route ever carries one — still takes
 * priority, so isolation for genuinely project-scoped operations is unchanged.
 * Routes without any such param simply become pass-through (control remains the
 * authority for who may create/own what — e.g. owner is taken from the JWT, Д-7).
 */
export const SkipProjectScope = () => SetMetadata(SKIP_PROJECT_SCOPE_KEY, true);
