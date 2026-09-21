import { SetMetadata } from '@nestjs/common';

export const REQUIRE_KEY_SCOPES = 'requireKeyScopes';

export interface RequireKeyScopesMeta {
  /** Handler is authorized if the presented key carries ANY of these scopes. */
  scopes: string[];
  /**
   * When set, the guard is fail-closed unless this env var is explicitly
   * `'false'` / `'0'` / `'off'` (staged rollback only). Unset or any other
   * value enforces the key (BOX default, FR-AUTH-400).
   */
  softEnforceEnv?: string;
}

/**
 * Declares the service-key scope(s) a gRPC handler requires (checked by
 * GrpcGatewayKeyGuard). Overrides the guard's default `['gateway:invoke']` for
 * this handler. Accepts either a plain list of scopes, or a config object with
 * an optional `softEnforceEnv` feature-flag for staged rollout.
 *
 *   @RequireKeyScopes('gateway:invoke', 'internal:user-directory')
 *   @RequireKeyScopes({ scopes: [...], softEnforceEnv: 'REQUIRE_KEY_FOR_RESOLVE_USERS' })
 */
export function RequireKeyScopes(
  ...args: [RequireKeyScopesMeta] | string[]
): MethodDecorator & ClassDecorator {
  const meta: RequireKeyScopesMeta =
    args.length === 1 && typeof args[0] === 'object'
      ? (args[0] as RequireKeyScopesMeta)
      : { scopes: args as string[] };
  return SetMetadata(REQUIRE_KEY_SCOPES, meta);
}
