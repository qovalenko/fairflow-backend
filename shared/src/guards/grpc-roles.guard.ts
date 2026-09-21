import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { RpcException } from '@nestjs/microservices';
import { status as GrpcStatus } from '@grpc/grpc-js';
import type { Metadata } from '@grpc/grpc-js';
import { REQUIRE_ROLES_KEY } from './require-roles.decorator';
import { readRoles } from '../grpc/inbound-metadata';
import { projectRoleAtLeast, type ProjectRole } from '../rbac';

/**
 * Domain-side PEP for coarse role gates (SEC-BLOCKER 1, Д-2). Reads the trusted
 * `x-roles` metadata propagated by the gateway and enforces `@RequireRoles(min)`
 * on the handler. Fail-closed: handlers without the decorator pass through (their
 * RBAC is handled upstream / by the service layer), but an annotated handler
 * denies the call whenever the propagated roles do not reach `minRole` — the
 * empty/absent case (no resolved user role, e.g. a raw s2s call bypassing the
 * gateway) is denied too, never granted.
 *
 * Register alongside the service-API-key guard (PEP) as an APP_GUARD; the order
 * is API-key first (authn), roles second (coarse authz).
 */
@Injectable()
export class GrpcRolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    if (context.getType() !== 'rpc') return true;

    const minRole = this.reflector.getAllAndOverride<ProjectRole | undefined>(
      REQUIRE_ROLES_KEY,
      [context.getHandler(), context.getClass()],
    );
    if (!minRole) return true;

    const metadata = context.getArgByIndex(1) as Metadata | undefined;
    const roles = readRoles(metadata);
    const ok = roles.some((r) => projectRoleAtLeast(r, minRole));
    if (!ok) {
      throw new RpcException({
        code: GrpcStatus.PERMISSION_DENIED,
        message: `FORBIDDEN: requires project role >= ${minRole}`,
      });
    }
    return true;
  }
}
