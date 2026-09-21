import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import {
  buildGatewayOutboundMetadata,
  serializeVisibilityScope,
  projectRoleCanKey,
  isProjectRole,
  type VisibilityScope,
} from '@fairflow/shared';
import { AppConfigService } from '../config/app-config.service';

type ReqLike = {
  headers: Record<string, unknown>;
  user?: { userId?: string; sessionId?: string; roles?: string; permissions?: string };
  /** Server-resolved single-tenant org anchor stashed by SystemOrgContextGuard
   * (DEORG-GW-1/GW-2). The client never supplies an org — this is the ONLY source
   * of `x-organization-id` downstream. */
  __systemOrgId?: string;
};

function flattenHeaders(req: ReqLike): Record<string, string | string[] | undefined> {
  const out: Record<string, string | string[] | undefined> = {};
  for (const [k, v] of Object.entries(req.headers)) {
    if (v === undefined) continue;
    out[k.toLowerCase()] = Array.isArray(v) ? v.map(String) : String(v);
  }
  return out;
}

/** Project-role → x-permissions for domain PEP (chat:moderate is the sole consumer today). */
function resolveOutboundPermissions(role: string | undefined, enabledModules?: string[]): string {
  if (!role || !isProjectRole(role)) return '';
  const keys: string[] = [];
  if (enabledModules?.includes('chat') && projectRoleCanKey(role, 'chat', 'moderate')) {
    keys.push('chat:moderate');
  }
  return keys.join(',');
}

@Injectable()
export class GatewayOutboundMetadataService {
  constructor(private readonly config: AppConfigService) {}

  build(
    req: ReqLike & {
      __enabledModules?: string[];
      __policySnapshot?: string;
      __projectRole?: string;
      __visibilityScope?: string;
      __accessPredicate?: string;
      __effectivePermissions?: string;
    },
    opts?: {
      projectId?: string;
      /** chat (M-CHAT-10, B-3): individual-mode workspace boundary. box is
       * single-tenant so the org anchor (below) always wins; kept for non-box
       * callers. Never sourced from the client. */
      workspaceId?: string;
      /** chat (B-3): corporate organization boundary for DM/group isolation.
       * DEORG-GW-2: sourced ONLY server-side — an explicit override here, else the
       * SystemOrgContextGuard-resolved `req.__systemOrgId`. Never from the client. */
      organizationId?: string;
    },
  ) {
    const key = this.config.gatewayServiceApiKey?.trim();
    if (!key) {
      throw new ServiceUnavailableException(
        'GATEWAY_SERVICE_API_KEY is not configured (seed auth DB and set env)',
      );
    }
    const uid = req.user?.userId?.trim();
    const hasUser = Boolean(uid);
    // Real per-project role resolved by ProjectAccessGuard; falls back to a
    // neutral 'USER' on routes without a project context.
    const projectRole = req.__projectRole?.trim();
    // DEORG-GW-2: the org anchor is server-resolved (SystemOrgContextGuard), NEVER
    // from a client header. `x-org-id`/`x-organization-id`/`x-workspace-id` are no
    // longer read off the request.
    const systemOrgId = req.__systemOrgId?.trim();
    return buildGatewayOutboundMetadata({
      serviceApiKey: key,
      gatewayApiKeyId: this.config.gatewayApiKeyId || '',
      headers: flattenHeaders(req),
      userId: uid,
      projectId: opts?.projectId,
      roles: hasUser ? projectRole || req.user?.roles || 'USER' : '',
      permissions: hasUser
        ? (req.__effectivePermissions ??
          req.user?.permissions ??
          resolveOutboundPermissions(
            projectRole,
            (req as Record<string, unknown>).__enabledModules as string[] | undefined,
          ))
        : '',
      sessionId: hasUser ? (req.user?.sessionId ?? '') : '',
      actorType: hasUser ? 'user' : 'service',
      enabledModules: (req as Record<string, unknown>).__enabledModules as string[] | undefined,
      modulePolicySnapshot: (req as Record<string, unknown>).__policySnapshot as string | undefined,
      visibilityScope: hasUser ? req.__visibilityScope : undefined,
      accessPredicate: hasUser ? req.__accessPredicate : undefined,
      workspaceId: hasUser ? opts?.workspaceId : undefined,
      organizationId: hasUser ? (opts?.organizationId ?? systemOrgId) : undefined,
    });
  }

  /**
   * Outbound metadata for the public project API (`/api/v1/public/*`, BX-INTEG-2).
   * The caller is an inbound `ffk_…` key resolved by `ProjectApiKeyGuard` — a
   * synthetic service actor (no end user), read-only, scoped to ONE project.
   *
   * It carries a `mode:'all'` visibility scope so the CRM domains return every
   * record of that project (`buildVisibilityFilter` → no record-level narrowing;
   * the domain still AND-s `projectId`, so isolation holds). No `accessPredicate`
   * (no ABAC narrowing), no user identity, no write capability — read is enforced
   * by exposing only GET routes behind the guard.
   */
  buildForApiKey(req: ReqLike, opts: { projectId: string }) {
    const key = this.config.gatewayServiceApiKey?.trim();
    if (!key) {
      throw new ServiceUnavailableException(
        'GATEWAY_SERVICE_API_KEY is not configured (seed auth DB and set env)',
      );
    }
    const allScope: VisibilityScope = {
      mode: 'all',
      level: 'custom',
      selfId: '',
      ownerIds: [],
      sharedRecordIds: [],
    };
    return buildGatewayOutboundMetadata({
      serviceApiKey: key,
      gatewayApiKeyId: this.config.gatewayApiKeyId || '',
      headers: flattenHeaders(req),
      projectId: opts.projectId,
      roles: '',
      permissions: '',
      sessionId: '',
      actorType: 'service',
      visibilityScope: serializeVisibilityScope(allScope),
    });
  }
}
