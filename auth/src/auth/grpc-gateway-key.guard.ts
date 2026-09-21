import { CanActivate, ExecutionContext, Injectable, Logger } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { RpcException } from '@nestjs/microservices';
import { status } from '@grpc/grpc-js';
import type { Metadata } from '@grpc/grpc-js';
import { ApiKeysService } from '../api-keys/api-keys.service';
import { SKIP_GATEWAY_KEY } from '../common/skip-gateway-key.decorator';
import {
  REQUIRE_KEY_SCOPES,
  type RequireKeyScopesMeta,
} from '../common/require-key-scopes.decorator';
import { GW_METADATA } from '@fairflow/shared';

const DEFAULT_SCOPES = ['gateway:invoke'];

@Injectable()
export class GrpcGatewayKeyGuard implements CanActivate {
  private readonly logger = new Logger(GrpcGatewayKeyGuard.name);

  constructor(
    private readonly apiKeys: ApiKeysService,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (context.getType() !== 'rpc') return true;
    const skip = this.reflector.getAllAndOverride<boolean>(SKIP_GATEWAY_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (skip) return true;

    const required = this.reflector.getAllAndOverride<RequireKeyScopesMeta>(REQUIRE_KEY_SCOPES, [
      context.getHandler(),
      context.getClass(),
    ]);
    const requiredScopes = required?.scopes?.length ? required.scopes : DEFAULT_SCOPES;
    // Soft mode is opt-out only: unset / true → fail-closed (FR-AUTH-400).
    // Explicit false/0/off keeps the staged-rollout escape hatch.
    const flag = required?.softEnforceEnv
      ? (process.env[required.softEnforceEnv] ?? '').trim().toLowerCase()
      : '';
    const soft =
      Boolean(required?.softEnforceEnv) && (flag === 'false' || flag === '0' || flag === 'off');

    const metadata = context.getArgByIndex(1) as Metadata | undefined;
    const raw = metadata?.get(GW_METADATA.SERVICE_API_KEY)?.[0];
    const key = typeof raw === 'string' ? raw : (raw?.toString?.() ?? '');
    const handlerName = this.handlerName(context);

    if (!key.trim()) {
      if (soft) {
        this.logger.warn(
          `${handlerName} called without a service key — allowed only while ${required?.softEnforceEnv}=false`,
        );
        return true;
      }
      throw new RpcException({
        code: status.UNAUTHENTICATED,
        message: 'Missing x-service-api-key',
      });
    }

    const info = await this.apiKeys.validate(key.trim());
    if (!info || !info.scopes.some((s) => requiredScopes.includes(s))) {
      if (soft) {
        this.logger.warn(
          `${handlerName} called with an invalid/insufficient service key — allowed only while ${required?.softEnforceEnv}=false`,
        );
        return true;
      }
      throw new RpcException({
        code: status.UNAUTHENTICATED,
        message: 'Invalid or insufficient service API key',
      });
    }
    return true;
  }

  private handlerName(context: ExecutionContext): string {
    try {
      return `${context.getClass().name}.${context.getHandler().name}`;
    } catch {
      return 'gRPC handler';
    }
  }
}
