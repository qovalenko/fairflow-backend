import { WellKnownController } from './well-known.controller';

describe('WellKnownController', () => {
  it('returns OIDC discovery document from OidcService', () => {
    const discovery = {
      issuer: 'http://localhost:3001',
      authorization_endpoint: 'http://localhost:3001/oauth/authorize',
    };
    const getDiscovery = jest.fn().mockReturnValue(discovery);
    const c = new WellKnownController({ getDiscovery } as never);
    expect(c.openIdConfiguration()).toBe(discovery);
    expect(getDiscovery).toHaveBeenCalled();
  });
});
