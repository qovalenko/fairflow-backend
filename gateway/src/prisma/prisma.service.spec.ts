jest.mock('@prisma/adapter-pg', () => ({
  PrismaPg: jest.fn().mockImplementation(() => ({})),
}));

jest.mock('../generated/prisma', () => {
  class PrismaClient {
    $connect = jest.fn().mockResolvedValue(undefined);
    $disconnect = jest.fn().mockResolvedValue(undefined);
  }
  return { PrismaClient };
});

import { PrismaService } from './prisma.service';

describe('PrismaService', () => {
  it('wires adapter from AppConfigService and connects on module init', async () => {
    const config = { databaseUrl: 'postgres://test/db' };
    const svc = new PrismaService(config as never);
    await svc.onModuleInit();
    expect(svc.$connect).toHaveBeenCalled();
    await svc.onModuleDestroy();
    expect(svc.$disconnect).toHaveBeenCalled();
  });
});
