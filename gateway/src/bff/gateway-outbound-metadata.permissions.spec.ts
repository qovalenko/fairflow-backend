import { GatewayOutboundMetadataService } from './gateway-outbound-metadata.service';
import { GW_METADATA } from '@fairflow/shared';

describe('GatewayOutboundMetadataService permissions', () => {
  const config = {
    gatewayServiceApiKey: 'ak_test',
    gatewayApiKeyId: 'key-1',
  } as never;

  it('projects chat:moderate for manager role when chat module is enabled', () => {
    const svc = new GatewayOutboundMetadataService(config);
    const md = svc.build(
      {
        headers: {},
        user: { userId: 'u1', sessionId: 's1' },
        __projectRole: 'manager',
        __enabledModules: ['chat', 'deals'],
      } as never,
      { projectId: 'p1' },
    );
    expect(md.get(GW_METADATA.PERMISSIONS)?.[0]).toBe('chat:moderate');
  });

  it('does not grant chat:moderate to member role', () => {
    const svc = new GatewayOutboundMetadataService(config);
    const md = svc.build(
      {
        headers: {},
        user: { userId: 'u1', sessionId: 's1' },
        __projectRole: 'member',
        __enabledModules: ['chat'],
      } as never,
      { projectId: 'p1' },
    );
    expect(md.get(GW_METADATA.PERMISSIONS)?.[0] ?? '').toBe('');
  });
});
