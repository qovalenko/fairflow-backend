import { OrganizationsService } from './organizations.service';

/**
 * FR-ORG-007: HasSystem reflects whether bootstrap completed (singleton org row).
 */
describe('OrganizationsService.hasSystem', () => {
  it('returns false before bootstrap and true once SystemSettings exists', async () => {
    let count = 0;
    const prisma = {
      systemSettings: {
        count: jest.fn(async () => count),
      },
    } as never;
    const service = new OrganizationsService(prisma, {} as never, {} as never, {} as never);

    expect(await service.hasSystem()).toBe(false);
    count = 1;
    expect(await service.hasSystem()).toBe(true);
  });
});
