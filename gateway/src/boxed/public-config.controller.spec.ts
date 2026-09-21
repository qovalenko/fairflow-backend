import { PublicConfigController } from './public-config.controller';

describe('PublicConfigController.getConfig', () => {
  function make(probe: string, hasSystem: boolean) {
    const bootstrapState = {
      probe: jest.fn().mockResolvedValue(probe),
      hasSystem: jest.fn().mockResolvedValue(hasSystem),
    };
    const ctrl = new PublicConfigController(bootstrapState as never);
    return { ctrl, bootstrapState };
  }

  it('sets needsBootstrap when auth is reachable but system org is missing', async () => {
    const { ctrl } = make('ready', false);
    await expect(ctrl.getConfig({ headers: {} } as never)).resolves.toEqual({
      deploymentMode: 'box',
      needsBootstrap: true,
      features: { billing: false, multiOrg: false },
      appName: 'Fairflow',
    });
  });

  it('does not bootstrap-gate when auth probe is unknown (FR-AUTH-023)', async () => {
    const { ctrl } = make('unknown', false);
    await expect(ctrl.getConfig({ headers: {} } as never)).resolves.toMatchObject({
      needsBootstrap: false,
    });
  });

  it('needsBootstrap is false when system org exists', async () => {
    const { ctrl } = make('ready', true);
    await expect(ctrl.getConfig({ headers: {} } as never)).resolves.toMatchObject({
      needsBootstrap: false,
    });
  });
});
