import { ServiceUnavailableException } from '@nestjs/common';
import { GW_METADATA } from '@fairflow/shared';
import { GatewayOutboundMetadataService } from './gateway-outbound-metadata.service';

describe('GatewayOutboundMetadataService.build', () => {
  const config = {
    gatewayServiceApiKey: 'ak_test',
    gatewayApiKeyId: 'key-1',
  } as never;

  it('throws when gateway service api key is missing', () => {
    const svc = new GatewayOutboundMetadataService({ gatewayServiceApiKey: '  ' } as never);
    expect(() => svc.build({ headers: {} })).toThrow(ServiceUnavailableException);
  });

  it('builds metadata for an authenticated project request', () => {
    const svc = new GatewayOutboundMetadataService(config);
    const md = svc.build(
      {
        headers: { 'x-request-id': 'rid-1' },
        user: { userId: 'u-1', sessionId: 's-1' },
        __projectRole: 'manager',
        __enabledModules: ['chat', 'deals'],
        __systemOrgId: ' org-1 ',
        __visibilityScope: 'scope-b64',
        __accessPredicate: 'pred-b64',
      } as never,
      { projectId: 'p-1' },
    );

    expect(md.get(GW_METADATA.SERVICE_API_KEY)?.[0]).toBe('ak_test');
    expect(md.get(GW_METADATA.USER_ID)?.[0]).toBe('u-1');
    expect(md.get(GW_METADATA.PROJECT_ID)?.[0]).toBe('p-1');
    expect(md.get(GW_METADATA.ORGANIZATION_ID)?.[0]).toBe('org-1');
    expect(md.get(GW_METADATA.VISIBILITY_SCOPE)?.[0]).toBe('scope-b64');
    expect(md.get(GW_METADATA.ACCESS_PREDICATE)?.[0]).toBe('pred-b64');
  });

  it('builds service-actor metadata for public API keys', () => {
    const svc = new GatewayOutboundMetadataService(config);
    const md = svc.buildForApiKey(
      { headers: { 'x-request-id': 'rid-2' } },
      { projectId: 'p-public' },
    );

    expect(md.get(GW_METADATA.USER_ID)?.[0] ?? '').toBe('');
    expect(md.get(GW_METADATA.ACTOR_TYPE)?.[0]).toBe('service');
    expect(md.get(GW_METADATA.PROJECT_ID)?.[0]).toBe('p-public');
    expect(md.get(GW_METADATA.VISIBILITY_SCOPE)?.[0]).toBeTruthy();
  });
});
