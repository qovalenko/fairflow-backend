import { ForbiddenException, type ExecutionContext } from '@nestjs/common';
import { DealReopenRoleGuard, DEAL_REOPEN_MIN_ROLE, CrmBffController } from './crm-bff.controller';

/**
 * B1 / FR-DEALS-130 — the gateway PEP for `POST deals/:id/reopen` must not be
 * weaker than the domain PDP.
 *
 * History: the route was gated by `deals:manage` (a settings permission the
 * manager role deliberately lacks), so managers could not reopen at all; the fix
 * dropped it to `deals:write`, which `member` owns (shared/rbac.ts
 * PROJECT_ROLE_ACTIONS) — i.e. the gateway then checked NOTHING and every project
 * member reached `PipeGrpc.ReopenDeal`, only to be refused by the domain's
 * `@RequireRoles('manager')`.
 *
 * The route now carries `deals:write` AND this guard, whose predicate is literally
 * the domain's own (`projectRoleAtLeast(role, 'manager')`, the helper
 * `GrpcRolesGuard` uses), so the two ends cannot drift apart.
 */
describe('DealReopenRoleGuard (B1)', () => {
  const guard = new DealReopenRoleGuard();

  /** Request as ProjectAccessGuard leaves it: project role resolved on `req`. */
  const ctxFor = (role?: string) =>
    ({
      switchToHttp: () => ({ getRequest: () => ({ __projectRole: role }) }),
    }) as unknown as ExecutionContext;

  it('mirrors the domain minimum role (manager)', () => {
    expect(DEAL_REOPEN_MIN_ROLE).toBe('manager');
  });

  it.each(['manager', 'admin', 'owner'])('%s passes the gate', (role) => {
    expect(guard.canActivate(ctxFor(role))).toBe(true);
  });

  it.each(['member', 'viewer'])('%s is denied by the PEP, not by the domain', (role) => {
    expect(() => guard.canActivate(ctxFor(role))).toThrow(ForbiddenException);
    try {
      guard.canActivate(ctxFor(role));
    } catch (e) {
      // Clean PEP verdict for the client (same shape as ProjectAccessGuard).
      expect((e as ForbiddenException).getResponse()).toMatchObject({
        code: 'PERMISSION_DENIED',
        subject: 'deals',
        requiredRole: 'manager',
      });
    }
  });

  it.each([undefined, '', 'platform_owner', 'nonsense'])(
    'fail-closed for an unresolved/unknown role (%s)',
    (role) => {
      expect(() => guard.canActivate(ctxFor(role as string | undefined))).toThrow(
        ForbiddenException,
      );
    },
  );

  it('is actually attached to the reopen route (not just declared)', () => {
    const guards = Reflect.getMetadata(
      '__guards__',
      CrmBffController.prototype.reopenDeal,
    ) as unknown[];
    expect(guards).toContain(DealReopenRoleGuard);
  });
});
