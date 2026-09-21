import { SeatsService } from './seats.service';
import type { PrismaService } from '../prisma/prisma.service';

describe('SeatsService (box edition)', () => {
  let prisma: { employee: { count: jest.Mock } };
  let service: SeatsService;

  beforeEach(() => {
    prisma = { employee: { count: jest.fn().mockResolvedValue(7) } };
    service = new SeatsService(prisma as unknown as PrismaService);
  });

  it('counts only active employees for an organization', async () => {
    await expect(service.countActive('org-1')).resolves.toBe(7);
    expect(prisma.employee.count).toHaveBeenCalledWith({
      where: { organizationId: 'org-1', isActive: true },
    });
  });

  it('reports unlimited seats and never over limit in box', async () => {
    await expect(service.getSeats('org-1')).resolves.toEqual({
      used: 7,
      total: Number.MAX_SAFE_INTEGER,
      overLimit: false,
      plan: 'box',
    });
  });

  it('assertSeatAvailable is a no-op in box', async () => {
    const counter = jest.fn().mockResolvedValue(999_999);
    await expect(service.assertSeatAvailable('org-1', counter)).resolves.toBeUndefined();
    expect(counter).not.toHaveBeenCalled();
  });

  it('invalidate is a no-op kept for SaaS parity', () => {
    expect(() => service.invalidate('org-1')).not.toThrow();
  });
});
