import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Inject,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ClientGrpcProxy } from '@nestjs/microservices';
import { firstValueFrom, type Observable } from 'rxjs';
import { orgRoleCanManage, permissionKey } from '@fairflow/shared';
import { GatewayOutboundMetadataService } from '../bff/gateway-outbound-metadata.service';
import {
  REQUIRED_SYSTEM_ROLE_KEY,
  type SystemRoleRequirement,
} from './require-system-role.decorator';
import {
  REQUIRED_ORG_STRUCTURE_PERMISSION_KEY,
  type RequiredOrgStructurePermission,
} from './require-org-structure-permission.decorator';

/** Wire shape of GetOrgRoleResponse (keepCase-tolerant). */
type GetOrgRoleResult = {
  role?: string;
  is_member?: boolean;
  isMember?: boolean;
  is_active?: boolean;
  isActive?: boolean;
};

type OrgRoleClient = {
  getOrgRole: (
    x: { organization_id: string; user_id: string },
    m?: unknown,
  ) => Observable<GetOrgRoleResult>;
  getOrgPermissionProjection: (
    x: { organization_id: string; user_id: string },
    m?: unknown,
  ) => Observable<{ allowed?: string[] }>;
};

type SystemScopedRequest = {
  headers?: Record<string, unknown>;
  user?: { userId?: string };
  __systemOrgId?: string;
};

/**
 * Cached system-membership decision. The single-tenant System has NO access-epoch
 * (the epoch mechanism is project-scoped — `ProjectAccessEpoch`), so this entry is
 * validated by TTL alone. The short default TTL bounds the worst-case revocation
 * lag (a demoted/offboarded employee keeps their old decision for at most
 * GATEWAY_ORG_ACCESS_CACHE_TTL_MS). control remains the source of truth on every
 * write, so a stale-cached ALLOW here only shortens the window in which the SECOND
 * layer (control PDP) still denies — never grants past control. Set the TTL to 0 to
 * re-resolve on every request. Keyed by `userId` (single-tenant ⇒ one org).
 */
const SYSTEM_ACCESS_CACHE = new Map<
  string,
  { role: string; isMember: boolean; isActive: boolean; expiresAt: number }
>();

function readTtlMs(envKey: string, fallback: number): number {
  const raw = process.env[envKey];
  if (raw === undefined) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}
function systemAccessCacheTtlMs(): number {
  return readTtlMs('GATEWAY_ORG_ACCESS_CACHE_TTL_MS', 10_000);
}

/**
 * SystemAccessGuard (DEORG-GW-3, ex-OrgAccessGuard) — PEP #1 for SYSTEM-level
 * routes (org structure of the single-tenant box), defense-in-depth.
 *
 * Symmetric peer of ProjectAccessGuard: where the project guard resolves a project
 * role from `:projectId`, this one resolves the caller's Employee (system) role via
 * control's thin `GetOrgRole` RPC, then enforces the route's `@RequireSystemRole`
 * requirement:
 *   - 'owner' → platform_owner only (FR-ORG-040: deactivate/reactivate).
 *   - 'manage' → owner/admin only (orgRoleCanManage) — every system mutation.
 *   - 'member' → any active employee — system structure reads.
 *
 * When `@RequireOrgStructurePermission` is also present, the guard performs a
 * second PDP check via `GetOrgPermissionProjection` (FR-ORG-740).
 *
 * The box de-orgification removed `:orgId` from every route (DEORG-GW-5): the guard
 * no longer parses a path param. control resolves the singleton itself (DEORG-BE-16)
 * and ignores the `organization_id` we pass; we still forward the server-resolved
 * `req.__systemOrgId` (SystemOrgContextGuard) for cache-key stability.
 *
 * This does NOT replace control's own checks (assertCanManage/assertMember) — it is
 * a second rubber-band so an employee is refused at the edge (403 on gateway, before
 * the RPC) and control-outages can't ferry a request past the first layer.
 *
 * Fail-closed: control unreachable while GATEWAY_ORG_ACCESS_ENFORCE!=false → 503.
 * Kill-switch disables denial only.
 */
@Injectable()
export class SystemAccessGuard implements CanActivate {
  private client?: OrgRoleClient;

  constructor(
    private readonly reflector: Reflector,
    @Inject('CONTROL_GRPC') private readonly control: ClientGrpcProxy,
    private readonly outboundMeta: GatewayOutboundMetadataService,
  ) {}

  private get enforce(): boolean {
    return process.env.GATEWAY_ORG_ACCESS_ENFORCE !== 'false';
  }

  private getClient(): OrgRoleClient {
    if (!this.client) {
      this.client = this.control.getService<OrgRoleClient>('OrganizationGrpc');
    }
    return this.client;
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const requirement = this.reflector.getAllAndOverride<SystemRoleRequirement | undefined>(
      REQUIRED_SYSTEM_ROLE_KEY,
      [context.getHandler(), context.getClass()],
    );
    const orgPerm = this.reflector.getAllAndOverride<RequiredOrgStructurePermission | undefined>(
      REQUIRED_ORG_STRUCTURE_PERMISSION_KEY,
      [context.getHandler(), context.getClass()],
    );
    // Route opts out of gateway system-enforcement (no decorator) → nothing to do
    // here; control still enforces. Same pass-through contract as the project
    // guard's "no projectId" branch.
    if (!requirement && !orgPerm) return true;

    const request = context.switchToHttp().getRequest<SystemScopedRequest>();
    const userId = request.user?.userId;
    if (!userId) {
      if (this.enforce) {
        throw new ForbiddenException({
          code: 'SYSTEM_ACCESS_DENIED',
          message: 'Authentication required for system-scoped access',
        });
      }
      return true;
    }

    const decision = await this.resolveSystemRole(request, userId);

    // Membership gate first (mirrors project guard's membership check): a
    // non-member (or offboarded employee) cannot read or mutate system structure.
    if (this.enforce && (!decision.isMember || !decision.isActive)) {
      throw new ForbiddenException({
        code: 'SYSTEM_ACCESS_DENIED',
        message: 'You are not an active member of this system',
      });
    }

    if (requirement === 'owner' && this.enforce && decision.role !== 'platform_owner') {
      throw new ForbiddenException({
        code: 'SYSTEM_PERMISSION_DENIED',
        message: 'Only the system owner can perform this action',
      });
    }

    if (requirement === 'manage' && this.enforce && !orgRoleCanManage(decision.role)) {
      throw new ForbiddenException({
        code: 'SYSTEM_PERMISSION_DENIED',
        message: `System role "${decision.role || 'none'}" cannot manage this system`,
      });
    }

    if (orgPerm && this.enforce) {
      const allowed = await this.resolveOrgStructurePermissions(request, userId);
      const key = permissionKey(orgPerm.subject, orgPerm.action);
      if (!allowed.has(key)) {
        throw new ForbiddenException({
          code: 'ORG_STRUCTURE_PERMISSION_DENIED',
          message: `Missing org-structure permission ${key}`,
        });
      }
    }

    return true;
  }

  private async resolveSystemRole(
    request: SystemScopedRequest,
    userId: string,
  ): Promise<{ role: string; isMember: boolean; isActive: boolean }> {
    const cacheKey = userId;
    const ttl = systemAccessCacheTtlMs();
    if (ttl > 0) {
      const cached = SYSTEM_ACCESS_CACHE.get(cacheKey);
      if (cached && cached.expiresAt > Date.now()) {
        return { role: cached.role, isMember: cached.isMember, isActive: cached.isActive };
      }
    }

    try {
      const md = this.outboundMeta.build(request as never);
      // control (DEORG-BE-16) ignores this organization_id and resolves the
      // singleton itself; the server-resolved anchor is forwarded for parity.
      const orgId = request.__systemOrgId ?? '';
      const res = await firstValueFrom(
        this.getClient().getOrgRole({ organization_id: orgId, user_id: userId }, md),
      );
      const decision = {
        role: res?.role ?? '',
        isMember: (res?.is_member ?? res?.isMember) === true,
        isActive: (res?.is_active ?? res?.isActive) === true,
      };
      if (ttl > 0) SYSTEM_ACCESS_CACHE.set(cacheKey, { ...decision, expiresAt: Date.now() + ttl });
      return decision;
    } catch {
      // Fail closed when enforcing: an outage must not slip a system mutation past
      // the edge (control might be the very thing that's down).
      if (this.enforce) {
        throw new ServiceUnavailableException({
          code: 'SYSTEM_ACCESS_CHECK_FAILED',
          message: 'Could not verify system membership',
        });
      }
      return { role: '', isMember: false, isActive: false };
    }
  }

  private async resolveOrgStructurePermissions(
    request: SystemScopedRequest,
    userId: string,
  ): Promise<Set<string>> {
    try {
      const md = this.outboundMeta.build(request as never);
      const orgId = request.__systemOrgId ?? '';
      const res = await firstValueFrom(
        this.getClient().getOrgPermissionProjection(
          { organization_id: orgId, user_id: userId },
          md,
        ),
      );
      return new Set(res?.allowed ?? []);
    } catch {
      if (this.enforce) {
        throw new ServiceUnavailableException({
          code: 'ORG_STRUCTURE_PERMISSION_CHECK_FAILED',
          message: 'Could not verify org-structure permissions',
        });
      }
      return new Set();
    }
  }
}

/** Test/ops helper: drop cached system decisions (whole system or a single member). */
export function invalidateSystemAccessCache(userId?: string) {
  if (!userId) {
    SYSTEM_ACCESS_CACHE.clear();
    return;
  }
  SYSTEM_ACCESS_CACHE.delete(userId);
}
