import { AppModule } from '../app.module';

/**
 * BOX edition: org-overview (cross-project Organization aggregate) is not registered
 * in the reports listener — no OrgOverviewModule import (TODO-104 / DEORG).
 */
describe('BOX reports app module', () => {
  it('does not import OrgOverviewModule', () => {
    const imports = Reflect.getMetadata('imports', AppModule) as unknown[];
    const names = imports.map((m) => (m as { name?: string }).name ?? String(m));
    expect(names.some((n) => n.includes('OrgOverview'))).toBe(false);
  });
});
