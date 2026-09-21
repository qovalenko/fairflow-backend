import { ORG_ROLE_PERMISSIONS, ORG_SYSTEM_PERMISSIONS } from './permission-rbac';
import { GW_METADATA } from './grpc/metadata-keys';
import { buildGatewayOutboundMetadata } from './grpc/outbound-metadata';

/** DEORG W-7: org-overview permissions and x-overview transport removed from BOX. */
describe('DEORG cleanup — permission-rbac', () => {
  it('does not expose org:overview keys in ORG_SYSTEM_PERMISSIONS', () => {
    const values = Object.values(ORG_SYSTEM_PERMISSIONS);
    expect(values.some((v) => v.includes('org:overview'))).toBe(false);
  });

  it('does not grant org:overview to platform roles', () => {
    const all = Object.values(ORG_ROLE_PERMISSIONS).flat();
    expect(all.some((v) => v.includes('org:overview'))).toBe(false);
  });
});

describe('DEORG cleanup — gateway metadata', () => {
  it('does not define x-overview transport keys', () => {
    expect(GW_METADATA).not.toHaveProperty('OVERVIEW_PROJECT_IDS');
    expect(GW_METADATA).not.toHaveProperty('OVERVIEW_BRANCH_DEPT_IDS');
    expect(GW_METADATA).not.toHaveProperty('ORG_ROLES');
  });

  it('buildGatewayOutboundMetadata does not accept orgOverview input', () => {
    const md = buildGatewayOutboundMetadata({
      serviceApiKey: 'ak_test',
      gatewayApiKeyId: 'kid',
      headers: {},
      actorType: 'user',
      userId: 'u1',
      projectId: 'p1',
      organizationId: 'org-1',
    });
    expect(md.get('x-overview-project-ids' as string)).toEqual([]);
    expect(md.get(GW_METADATA.ORGANIZATION_ID)).toEqual(['org-1']);
  });
});
