import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { RpcException } from '@nestjs/microservices';
import { status as GrpcStatus } from '@grpc/grpc-js';
import { REQUIRED_MODULE_KEY } from './require-module.decorator';
import { GW_METADATA } from '../grpc/metadata-keys';
import { readUserId } from '../grpc/inbound-metadata';

/**
 * gRPC-level module guard for downstream services.
 * Reads `x-enabled-modules` from inbound gRPC metadata and checks against
 * the `@RequireModule(moduleId)` decorator on the handler.
 */
@Injectable()
export class ModuleGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const requiredModule = this.reflector.getAllAndOverride<string | undefined>(
      REQUIRED_MODULE_KEY,
      [context.getHandler(), context.getClass()],
    );
    if (!requiredModule) return true;

    const type = context.getType();
    let enabledModules: string[] | undefined;

    if (type === 'rpc') {
      const metadata = context.switchToRpc().getContext();
      const raw = metadata?.get?.(GW_METADATA.ENABLED_MODULES)?.[0];
      if (typeof raw === 'string') {
        try {
          enabledModules = JSON.parse(raw);
        } catch {
          enabledModules = undefined;
        }
      }
    } else if (type === 'http') {
      const request = context.switchToHttp().getRequest();
      const raw = request.headers?.[GW_METADATA.ENABLED_MODULES];
      if (typeof raw === 'string') {
        try {
          enabledModules = JSON.parse(raw);
        } catch {
          enabledModules = undefined;
        }
      }
    }

    // BR-PLATFORM-060: absent metadata = fail-open for pure s2s callers (no
    // x-user-id). User-context calls from gateway ALWAYS carry x-enabled-modules
    // after ProjectAccessGuard — missing header here means a wiring bug and must
    // fail-closed (FR-PROJ-320), without blocking automation→domain s2s paths.
    if (!enabledModules) {
      if (type === 'rpc') {
        const metadata = context.switchToRpc().getContext();
        if (readUserId(metadata)) {
          throw new RpcException({
            code: GrpcStatus.FAILED_PRECONDITION,
            message: 'MODULE_GATE_METADATA_MISSING: x-enabled-modules required for user-context gRPC',
          });
        }
      }
      return true;
    }

    if (!enabledModules.includes(requiredModule)) {
      throw new RpcException({
        code: GrpcStatus.PERMISSION_DENIED,
        message: `MODULE_DISABLED: ${requiredModule}`,
      });
    }

    return true;
  }
}
