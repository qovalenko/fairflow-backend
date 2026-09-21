import { Logger } from '@nestjs/common';
import { ProjectAccessEpochService } from './project-access-epoch.service';
import type { PrismaService } from '../prisma/prisma.service';

describe('ProjectAccessEpochService', () => {
  let prisma: {
    $executeRawUnsafe: jest.Mock;
    $queryRawUnsafe: jest.Mock;
  };
  let service: ProjectAccessEpochService;
  let errorSpy: jest.SpyInstance;

  beforeEach(() => {
    prisma = {
      $executeRawUnsafe: jest.fn().mockResolvedValue(1),
      $queryRawUnsafe: jest.fn().mockResolvedValue([{ epoch: 3n }]),
    };
    service = new ProjectAccessEpochService(prisma as unknown as PrismaService);
    errorSpy = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    errorSpy.mockRestore();
  });

  it('no-ops bump for empty project id', async () => {
    await service.bump('');
    expect(prisma.$executeRawUnsafe).not.toHaveBeenCalled();
  });

  it('atomically upserts the project epoch on bump', async () => {
    await service.bump('proj-1');
    expect(prisma.$executeRawUnsafe).toHaveBeenCalledWith(
      expect.stringContaining('ProjectAccessEpoch'),
      'proj-1',
    );
  });

  it('logs but does not throw when bump fails', async () => {
    prisma.$executeRawUnsafe.mockRejectedValue(new Error('db down'));
    await expect(service.bump('proj-1')).resolves.toBeUndefined();
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('proj-1'));
  });

  it('bumps all projects owned by an organization', async () => {
    await service.bumpOrgProjects('org-1');
    expect(prisma.$executeRawUnsafe).toHaveBeenCalledWith(
      expect.stringContaining('owner_id'),
      'org-1',
    );
  });

  it('returns 0 for empty project id in get()', async () => {
    await expect(service.get('')).resolves.toBe(0);
    expect(prisma.$queryRawUnsafe).not.toHaveBeenCalled();
  });

  it('returns the stored epoch as a number', async () => {
    prisma.$queryRawUnsafe.mockResolvedValue([{ epoch: 42 }]);
    await expect(service.get('proj-1')).resolves.toBe(42);
  });

  it('returns 0 when no epoch row exists yet', async () => {
    prisma.$queryRawUnsafe.mockResolvedValue([]);
    await expect(service.get('proj-new')).resolves.toBe(0);
  });
});
