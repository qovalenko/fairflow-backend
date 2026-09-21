import { BffApiModule } from './bff-api.module';

/**
 * BOX gateway: org-overview BFF routes are not registered (TODO-104 / DEORG).
 */
describe('BOX gateway BFF controllers', () => {
  it('does not register OrgOverviewBffController', () => {
    const controllers = Reflect.getMetadata('controllers', BffApiModule) as Array<{ name: string }>;
    const names = controllers.map((c) => c.name);
    expect(names).not.toContain('OrgOverviewBffController');
  });
});
