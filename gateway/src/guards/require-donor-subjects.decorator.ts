import { SetMetadata } from '@nestjs/common';

export const REQUIRED_DONOR_SUBJECTS_KEY = 'requiredDonorSubjects';

/**
 * Composite (card/aggregate) routes read data from OTHER modules than their own
 * `@RequirePermission` subject. `ProjectAccessGuard` resolves exactly one
 * visibility scope + one ABAC predicate — for the route's own subject — so a
 * composite that forwards that one metadata bundle to donor domains hands them
 * the WRONG scope: a user with wide visibility on `companies` but narrow
 * visibility on `deals` would receive, through the company card, deals that the
 * `/deals` list itself refuses to show. Read gate ≠ write gate, but read gate of
 * module A must never become the read gate of module B.
 *
 * Marking a route with `@RequireDonorSubjects('contacts','deals',…)` makes the
 * guard resolve each donor subject **independently** (RBAC key, project-wide
 * policy DENY, per-resource visibility scope, ABAC predicate) and stash the
 * result in `req.__donorAccess`. The composite then builds one outbound metadata
 * per donor (see `V1DataBffController.donorMd`). A donor the caller may not read
 * resolves to `null` ⇒ that block of the card is empty, never populated with the
 * host subject's scope.
 *
 * Fail-closed by construction: anything unresolvable (control outage, throw,
 * missing entry) is `null` ⇒ empty block, never "fall back to the route scope".
 */
export const RequireDonorSubjects = (...subjects: string[]) =>
  SetMetadata(REQUIRED_DONOR_SUBJECTS_KEY, subjects);
