import { Controller, Get, Req, VERSION_NEUTRAL } from '@nestjs/common';
import { ApiTags, ApiOperation } from '@nestjs/swagger';
import type { FastifyRequest } from 'fastify';
import { Public } from '../common/public.decorator';
import { BootstrapStateService } from './bootstrap-state.service';

type ReqLike = FastifyRequest & { user?: { userId?: string } };

/**
 * box (on-prem, §5.3): the single public, auth-free runtime-config endpoint the
 * FE fetches once before the router. It is the ONE source of truth for whether
 * onboarding is needed and which features are on.
 */
@Controller({ path: '', version: VERSION_NEUTRAL })
export class PublicConfigController {
  constructor(private readonly bootstrapState: BootstrapStateService) {}

  @Public()
  @Get('public-config')
  @ApiTags('Public')
  @ApiOperation({ summary: 'Public runtime config (deployment mode + features + bootstrap need)' })
  async getConfig(@Req() req: ReqLike) {
    // FR-ORG-007: bootstrap until the singleton system org exists (partial
    // Register→CreateOrg failures must replay, not merely «no user row»).
    // FR-AUTH-023: an unreachable auth ('unknown') must NOT raise the flag — the
    // FE gate sends every route to /bootstrap on it, locking out signed-in users.
    const probeState = await this.bootstrapState.probe(req);
    const hasSystem = await this.bootstrapState.hasSystem(req);
    const needsBootstrap = !hasSystem && probeState !== 'unknown';

    return {
      deploymentMode: 'box',
      needsBootstrap,
      // box is single-tenant with no billing plane.
      features: {
        billing: false,
        multiOrg: false,
      },
      appName: 'Fairflow',
    };
  }
}
