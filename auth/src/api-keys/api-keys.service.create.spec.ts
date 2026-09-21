jest.mock('../prisma/prisma.service', () => ({ PrismaService: class {} }));

import { ApiKeysService } from './api-keys.service';

/**
 * Unit tests for the ApiKeysService key-minting side (QA-CI T-036.1) — the
 * service-API-key create/revoke path that provisions the gateway→domain keys.
 * Prisma mocked; the real key generation (ak_ prefix, hash, prefix slice) runs.
 */
describe('ApiKeysService key minting', () => {
  const makeService = () => {
    const create = jest.fn();
    const update = jest.fn().mockResolvedValue({});
    const prisma = { apiKey: { create, update } };
    return { service: new ApiKeysService(prisma as never), create, update };
  };

  it('generateKey produces an ak_-prefixed key; hashKey/keyPrefix are stable', () => {
    const { service } = makeService();
    const key = service.generateKey();
    expect(key.startsWith('ak_')).toBe(true);
    expect(key.length).toBeGreaterThan('ak_'.length + 20);
    // sha256 hex, deterministic
    expect(service.hashKey(key)).toBe(service.hashKey(key));
    expect(service.hashKey(key)).toMatch(/^[0-9a-f]{64}$/);
    // prefix = ak_ + first 8 chars of the random body
    expect(service.keyPrefix(key)).toBe(key.slice(0, 3 + 8));
  });

  it('create persists the HASH (never the plaintext) and returns the plaintext once', async () => {
    const { service, create } = makeService();
    create.mockResolvedValue({ id: 'k-1' });
    const res = await service.create({
      name: 'gw',
      clientId: 'gateway',
      scopes: ['gateway:invoke'],
    });
    expect(res.id).toBe('k-1');
    expect(res.key.startsWith('ak_')).toBe(true);
    const data = create.mock.calls[0][0].data;
    expect(data.keyHash).toBe(service.hashKey(res.key));
    expect(data.keyHash).not.toBe(res.key); // plaintext is not stored
    expect(data.scopes).toEqual(['gateway:invoke']);
  });

  it('create defaults scopes to [] when omitted', async () => {
    const { service, create } = makeService();
    create.mockResolvedValue({ id: 'k-2' });
    await service.create({ name: 'x' });
    expect(create.mock.calls[0][0].data.scopes).toEqual([]);
  });

  it('revoke deactivates the key by id (isActive:false)', async () => {
    const { service, update } = makeService();
    await service.revoke('k-1');
    expect(update).toHaveBeenCalledWith({ where: { id: 'k-1' }, data: { isActive: false } });
  });
});
