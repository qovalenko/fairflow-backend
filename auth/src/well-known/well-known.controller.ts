import { Controller, Get } from '@nestjs/common';
import { OidcService } from '../oidc/oidc.service';

@Controller('.well-known')
export class WellKnownController {
  constructor(private readonly oidc: OidcService) {}

  @Get('openid-configuration')
  openIdConfiguration() {
    return this.oidc.getDiscovery();
  }
}
