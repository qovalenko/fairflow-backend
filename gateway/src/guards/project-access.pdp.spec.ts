import { ForbiddenException } from '@nestjs/common';
import { of, throwError, NEVER } from 'rxjs';
import { projectRoleCanKey, type PermissionAction } from '@fairflow/shared';
import { ProjectAccessGuard, invalidateProjectAccessCache } from './project-access.guard';
import { REQUIRED_PERMISSION_KEY } from './require-permission.decorator';
import { SKIP_PROJECT_SCOPE_KEY } from './skip-project-scope.decorator';
import { MEMBERSHIP_ONLY_KEY } from './membership-only.decorator';
import { REQUIRED_SYSTEM_ROLE_KEY } from './require-system-role.decorator';

/**
 * TODO-027 — PEP ↔ PDP. The gateway used to enforce exactly one rule (the flat
 * role×action matrix), so custom roles and addressed `PermissionGrant{deny}`
 * never produced a 403. These tests pin the new contract of the enforcement path:
 *
 *  1. FAIL-CLOSED — no decision (outage / timeout / empty / short / garbled
 *     response) is a denial, never a silent fallback to the flat matrix;
 *  2. deny > allow — a denial from control wins over a matrix allow;
 *  3. a custom role / a deny-grant is really enforced on the live route;
 *  4. base roles decide EXACTLY as before (the matrix stays the pre-filter, the
 *     PDP can only narrow — see the role×subject×action table below);
 *  5. the epoch invalidates the verdict cache (no new invalidation mechanism).
 */
describe('ProjectAccessGuard — granular PDP enforcement (TODO-027)', () => {
  const OLD_ENV = { ...process.env };

  let resolveRecordVisibility: jest.Mock;
  let getProjectAccessEpoch: jest.Mock;
  let getProject: jest.Mock;
  let checkPermissions: jest.Mock;
  let resolveEffectivePermissions: jest.Mock;

  const control = {
    getService: () => ({
      resolveRecordVisibility,
      getProjectAccessEpoch,
      getProject,
      checkPermissions,
      resolveEffectivePermissions,
    }),
  };
  const outboundMeta = { build: jest.fn(() => ({})) };

  const makeReflector = (required?: unknown) => ({
    getAllAndOverride: jest.fn((key: unknown) => {
      if (key === REQUIRED_PERMISSION_KEY) return required;
      if (key === SKIP_PROJECT_SCOPE_KEY) return undefined;
      if (key === REQUIRED_SYSTEM_ROLE_KEY) return undefined;
      if (key === MEMBERSHIP_ONLY_KEY) return required === undefined;
      return undefined;
    }),
  });

  const makeContext = (request: unknown) =>
    ({
      switchToHttp: () => ({ getRequest: () => request }),
      getHandler: () => undefined,
      getClass: () => undefined,
    }) as never;

  const makeGuard = (required?: unknown) =>
    new ProjectAccessGuard(
      makeReflector(required) as never,
      control as never,
      outboundMeta as never,
    );

  /** A request as the JWT guard leaves it: authenticated user + project header. */
  const req = (projectId = 'p-1', userId = 'u-1') => ({
    user: { userId },
    headers: { 'x-project-id': projectId },
  });

  /** Answer of a control that decided `decision` for every asked pair. */
  const answer = (
    decision: 'allow' | 'deny',
    reason: string,
    extra: Record<string, unknown> = {},
  ) =>
    jest.fn((r: { checks: Array<{ subject: string; action: string }> }) =>
      of({
        decisions: r.checks.map((c) => ({ ...c, decision, reason, ...extra })),
        epoch: 1,
      }),
    );

  beforeEach(() => {
    process.env.GATEWAY_ACCESS_CACHE_TTL_MS = '0';
    process.env.GATEWAY_POLICY_CACHE_TTL_MS = '0';
    process.env.GATEWAY_EPOCH_CACHE_TTL_MS = '0';
    process.env.GATEWAY_PDP_CACHE_TTL_MS = '0';
    process.env.GATEWAY_PROJECT_ACCESS_ENFORCE = 'true';

    // A manager: passes the flat matrix for every pair used below except the
    // manage/admin ones, so the PDP layer is what the assertions isolate.
    resolveRecordVisibility = jest.fn(() => of({ allowed: true, role: 'manager', epoch: 1 }));
    getProjectAccessEpoch = jest.fn(() => of({ epoch: 1 }));
    getProject = jest.fn(() => of({ effective_modules: [], module_policies: [] }));
    checkPermissions = answer('allow', 'OK');
    resolveEffectivePermissions = jest.fn(() => of({ allow: [], epoch: 1 }));
    outboundMeta.build.mockClear();
    invalidateProjectAccessCache('p-1');
  });

  afterEach(() => {
    process.env = { ...OLD_ENV };
    invalidateProjectAccessCache('p-1');
  });

  // ── 1. fail-closed ──────────────────────────────────────────────────────────

  describe('fail-closed', () => {
    it('denies when control is unreachable (no silent fallback to the flat matrix)', async () => {
      // The flat matrix WOULD allow this (manager may delete) — the whole point
      // is that an unavailable PDP must not resurrect the old behaviour.
      expect(projectRoleCanKey('manager', 'deals', 'delete')).toBe(true);
      checkPermissions = jest.fn(() => throwError(() => new Error('UNAVAILABLE')));
      const guard = makeGuard({ subject: 'deals', action: 'delete' });
      await expect(guard.canActivate(makeContext(req()))).rejects.toBeInstanceOf(
        ForbiddenException,
      );
    });

    it('denies with PERMISSION_CHECK_FAILED and does not leak an allow', async () => {
      checkPermissions = jest.fn(() => throwError(() => new Error('boom')));
      const guard = makeGuard({ subject: 'deals', action: 'read' });
      await expect(guard.canActivate(makeContext(req()))).rejects.toMatchObject({
        response: { code: 'PERMISSION_CHECK_FAILED', subject: 'deals', action: 'read' },
      });
    });

    it('denies when control never answers (deadline)', async () => {
      process.env.GATEWAY_PDP_TIMEOUT_MS = '20';
      checkPermissions = jest.fn(() => NEVER);
      const guard = makeGuard({ subject: 'deals', action: 'read' });
      await expect(guard.canActivate(makeContext(req()))).rejects.toMatchObject({
        response: { code: 'PERMISSION_CHECK_FAILED' },
      });
    });

    it('denies on an empty response body', async () => {
      checkPermissions = jest.fn(() => of({}));
      const guard = makeGuard({ subject: 'deals', action: 'read' });
      await expect(guard.canActivate(makeContext(req()))).rejects.toMatchObject({
        response: { code: 'PERMISSION_DENIED', reason: 'PDP_NO_DECISION' },
      });
    });

    it('denies when the response carries no verdict for the asked pair', async () => {
      checkPermissions = jest.fn(() =>
        of({ decisions: [{ subject: 'contacts', action: 'read', decision: 'allow' }], epoch: 1 }),
      );
      const guard = makeGuard({ subject: 'deals', action: 'read' });
      await expect(guard.canActivate(makeContext(req()))).rejects.toMatchObject({
        response: { code: 'PERMISSION_DENIED', reason: 'PDP_NO_DECISION' },
      });
    });

    it('denies on an unknown/garbled decision value (only "allow" allows)', async () => {
      checkPermissions = answer('ALLOW' as never, 'OK');
      const guard = makeGuard({ subject: 'deals', action: 'read' });
      await expect(guard.canActivate(makeContext(req()))).rejects.toBeInstanceOf(
        ForbiddenException,
      );
    });

    it('a truncated decision (proto3 defaults only) denies — not_applicable=false wins', async () => {
      // Exactly what a zero-valued proto3 message decodes to.
      checkPermissions = jest.fn(() =>
        of({ decisions: [{ subject: 'deals', action: 'read' }], epoch: 1 }),
      );
      const guard = makeGuard({ subject: 'deals', action: 'read' });
      await expect(guard.canActivate(makeContext(req()))).rejects.toBeInstanceOf(
        ForbiddenException,
      );
    });
  });

  // ── 2 & 3. deny wins; custom roles / grants are really enforced ──────────────

  describe('deny beats allow', () => {
    it('a deny-grant 403s a route the flat matrix allows (DENIED_BY_GRANT)', async () => {
      expect(projectRoleCanKey('manager', 'contacts', 'export')).toBe(true);
      checkPermissions = answer('deny', 'DENIED_BY_GRANT');
      const guard = makeGuard({ subject: 'contacts', action: 'export' });
      await expect(guard.canActivate(makeContext(req()))).rejects.toMatchObject({
        response: {
          code: 'PERMISSION_DENIED',
          subject: 'contacts',
          action: 'export',
          reason: 'DENIED_BY_GRANT',
        },
      });
    });

    it('a custom role without the key 403s DELETE (NOT_IN_ANY_ROLE)', async () => {
      expect(projectRoleCanKey('manager', 'deals', 'delete')).toBe(true);
      checkPermissions = answer('deny', 'NOT_IN_ANY_ROLE');
      const guard = makeGuard({ subject: 'deals', action: 'delete' });
      await expect(guard.canActivate(makeContext(req()))).rejects.toMatchObject({
        response: { code: 'PERMISSION_DENIED', reason: 'NOT_IN_ANY_ROLE' },
      });
    });

    it('the PDP can only narrow: an allow verdict never rescues a matrix deny', async () => {
      // viewer + write: the matrix denies BEFORE any network call is made.
      resolveRecordVisibility = jest.fn(() => of({ allowed: true, role: 'viewer', epoch: 1 }));
      checkPermissions = answer('allow', 'OK');
      const guard = makeGuard({ subject: 'deals', action: 'write' });
      await expect(guard.canActivate(makeContext(req()))).rejects.toBeInstanceOf(
        ForbiddenException,
      );
      expect(checkPermissions).not.toHaveBeenCalled();
    });
  });

  // ── 4. base-role parity + the abstain contract ──────────────────────────────

  describe('backwards compatibility of the base role model', () => {
    /**
     * Base roles (owner/admin/manager/member/viewer) must decide EXACTLY as
     * before. The mechanism: control resolves a base role's effective set from
     * the SAME expansion the matrix encodes, so it answers `allow` wherever the
     * matrix does; the table below asserts the composed result end-to-end.
     */
    const table: Array<[string, string, string, boolean]> = [
      // role, subject, action, expected allow
      ['owner', 'project', 'manage', true],
      ['admin', 'project', 'manage', true],
      ['manager', 'project', 'manage', false],
      ['member', 'project', 'manage', false],
      ['viewer', 'project', 'manage', false],
      ['owner', 'deals', 'delete', true],
      ['admin', 'deals', 'delete', true],
      ['manager', 'deals', 'delete', true],
      ['member', 'deals', 'delete', false],
      ['viewer', 'deals', 'delete', false],
      ['manager', 'deals', 'move', true],
      ['member', 'deals', 'move', true],
      ['viewer', 'deals', 'move', false],
      ['member', 'deals', 'write', true],
      ['viewer', 'deals', 'write', false],
      ['viewer', 'deals', 'read', true],
      ['member', 'documents.generate', 'execute', true],
      ['viewer', 'documents.generate', 'execute', false],
      ['manager', 'contacts', 'import', true],
      ['member', 'contacts', 'import', false],
      ['member', 'contacts', 'export', true],
    ];

    it.each(table)(
      '%s × %s:%s decides as the flat matrix did',
      async (role, subject, action, expected) => {
        // Control mirrors the matrix for a plain base role (that is what
        // expandSystemRolePermissions guarantees; see the control-side suite).
        resolveRecordVisibility = jest.fn(() => of({ allowed: true, role, epoch: 1 }));
        checkPermissions = jest.fn((r: { checks: Array<{ subject: string; action: string }> }) =>
          of({
            decisions: r.checks.map((c) => ({
              ...c,
              decision: projectRoleCanKey(role, c.subject, c.action as PermissionAction)
                ? 'allow'
                : 'deny',
              reason: 'OK',
            })),
            epoch: 1,
          }),
        );
        expect(projectRoleCanKey(role, subject, action as PermissionAction)).toBe(expected);
        const guard = makeGuard({ subject, action });
        if (expected) {
          await expect(guard.canActivate(makeContext(req()))).resolves.toBe(true);
        } else {
          await expect(guard.canActivate(makeContext(req()))).rejects.toBeInstanceOf(
            ForbiddenException,
          );
        }
      },
    );

    it('keeps the flat-matrix verdict when the pair has no catalog key (not_applicable)', async () => {
      // `statistics:delete` has no key in the manifest catalog — the granular
      // engine cannot store an opinion about it, so the route must not 403.
      checkPermissions = answer('deny', 'NO_CATALOG_KEY', { not_applicable: true });
      const guard = makeGuard({ subject: 'statistics', action: 'delete' });
      await expect(guard.canActivate(makeContext(req()))).resolves.toBe(true);
    });

    it('an outage can never masquerade as not_applicable', async () => {
      checkPermissions = jest.fn(() => throwError(() => new Error('down')));
      const guard = makeGuard({ subject: 'statistics', action: 'delete' });
      await expect(guard.canActivate(makeContext(req()))).rejects.toBeInstanceOf(
        ForbiddenException,
      );
    });

    it('routes without @RequirePermission never call the PDP', async () => {
      const guard = makeGuard(undefined);
      await expect(guard.canActivate(makeContext(req()))).resolves.toBe(true);
      expect(checkPermissions).not.toHaveBeenCalled();
    });
  });

  // ── 5. caching / epoch invalidation ─────────────────────────────────────────

  describe('verdict cache', () => {
    it('adds exactly one round-trip on a miss and none on a hit', async () => {
      process.env.GATEWAY_PDP_CACHE_TTL_MS = '30000';
      process.env.GATEWAY_EPOCH_CACHE_TTL_MS = '30000';
      invalidateProjectAccessCache('p-1');
      const guard = makeGuard({ subject: 'deals', action: 'read' });
      await expect(guard.canActivate(makeContext(req()))).resolves.toBe(true);
      await expect(guard.canActivate(makeContext(req()))).resolves.toBe(true);
      await expect(guard.canActivate(makeContext(req()))).resolves.toBe(true);
      expect(checkPermissions).toHaveBeenCalledTimes(1);
    });

    it('caches per (project,user,subject,action) — a different pair re-asks', async () => {
      process.env.GATEWAY_PDP_CACHE_TTL_MS = '30000';
      process.env.GATEWAY_EPOCH_CACHE_TTL_MS = '30000';
      invalidateProjectAccessCache('p-1');
      await makeGuard({ subject: 'deals', action: 'read' }).canActivate(makeContext(req()));
      await makeGuard({ subject: 'deals', action: 'write' }).canActivate(makeContext(req()));
      expect(checkPermissions).toHaveBeenCalledTimes(2);
    });

    it('an epoch bump invalidates a cached allow (admin adds a deny-grant)', async () => {
      process.env.GATEWAY_PDP_CACHE_TTL_MS = '30000';
      process.env.GATEWAY_EPOCH_CACHE_TTL_MS = '0';
      invalidateProjectAccessCache('p-1');
      await expect(
        makeGuard({ subject: 'deals', action: 'delete' }).canActivate(makeContext(req())),
      ).resolves.toBe(true);

      // Admin denies the key → control bumps the project access epoch. The guard
      // memoizes its gRPC service handle, so a fresh instance stands in for the
      // next request hitting the (still populated, now stale) module-level cache.
      getProjectAccessEpoch = jest.fn(() => of({ epoch: 2 }));
      checkPermissions = jest.fn((r: { checks: Array<{ subject: string; action: string }> }) =>
        of({
          decisions: r.checks.map((c) => ({ ...c, decision: 'deny', reason: 'DENIED_BY_GRANT' })),
          epoch: 2,
        }),
      );
      await expect(
        makeGuard({ subject: 'deals', action: 'delete' }).canActivate(makeContext(req())),
      ).rejects.toMatchObject({
        response: { reason: 'DENIED_BY_GRANT' },
      });
    });

    it('does not cache a verdict whose freshness could not be confirmed', async () => {
      process.env.GATEWAY_PDP_CACHE_TTL_MS = '30000';
      process.env.GATEWAY_EPOCH_CACHE_TTL_MS = '30000';
      invalidateProjectAccessCache('p-1');
      // Epoch read fails → sentinel -1 → the verdict must not be stored.
      getProjectAccessEpoch = jest.fn(() => throwError(() => new Error('epoch down')));
      const guard = makeGuard({ subject: 'deals', action: 'read' });
      await expect(guard.canActivate(makeContext(req()))).resolves.toBe(true);
      await expect(guard.canActivate(makeContext(req()))).resolves.toBe(true);
      expect(checkPermissions).toHaveBeenCalledTimes(2);
    });

    it('sends the project/user/pair control needs, with outbound metadata', async () => {
      const guard = makeGuard({ subject: 'deals', action: 'delete' });
      await guard.canActivate(makeContext(req('p-1', 'u-7')));
      expect(checkPermissions).toHaveBeenCalledWith(
        {
          project_id: 'p-1',
          user_id: 'u-7',
          checks: [{ subject: 'deals', action: 'delete' }],
        },
        expect.anything(),
      );
    });
  });
});
