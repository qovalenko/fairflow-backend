import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { SystemOrgResolverService } from '../bff/system-org-resolver.service';

type ReqLike = {
  headers: Record<string, unknown>;
  user?: { userId?: string };
  __systemOrgId?: string;
};

/**
 * SystemOrgContextGuard (DEORG-GW-1/GW-2) — a context populator, NOT an access
 * gate. It resolves the single-tenant box org anchor server-side and stashes it on
 * `req.__systemOrgId`, mirroring the existing `req.__projectRole` / `req.__enabledModules`
 * stash pattern that later runs synchronously in GatewayOutboundMetadataService.
 *
 * Applied (first, before the access guards) on the controllers whose downstream
 * needs the org anchor once the client stopped supplying it: org structure
 * (V1DataBffController) and chat DM/group isolation (ChatBffController).
 * It NEVER denies — resolution failure leaves the stash
 * empty and the real access guards / control PDP stay fail-closed.
 */
@Injectable()
export class SystemOrgContextGuard implements CanActivate {
  constructor(private readonly systemOrg: SystemOrgResolverService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<ReqLike>();
    if (req.user?.userId) {
      req.__systemOrgId = await this.systemOrg.resolveSystemOrgId(req);
    }
    return true;
  }
}
