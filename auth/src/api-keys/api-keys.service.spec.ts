// Stub the Prisma provider so importing ApiKeysService does not pull in the
// generated Prisma client runtime (unrelated to this unit; a fake Prisma is
// injected into every case below).
jest.mock('../prisma/prisma.service', () => ({ PrismaService: class {} }));

import { ApiKeysService } from './api-keys.service';
import { ApiKeyGrpcController } from './api-key.grpc.controller';
import { GrpcGatewayKeyGuard } from '../auth/grpc-gateway-key.guard';
import { GW_METADATA } from '@fairflow/shared';

/**
 * Unit tests for the service-API-key validation path that gates every
 * gateway→domain gRPC call. Prisma is mocked; the real hashing + active/expiry
 * + scope logic runs.
 */
import { SERVICE_API_KEY_CACHE_TTL_MS } from './api-keys.service';

describe('NFR-AUTH-030 service API key cache contract', () => {
  it('fixes the maximum validation cache TTL at 60s', () => {
    expect(SERVICE_API_KEY_CACHE_TTL_MS).toBe(60_000);
  });
});

describe('ApiKeysService.validate (service API key)', () => {
  let findFirst: jest.Mock;
  let update: jest.Mock;
  let service: ApiKeysService;

  const prisma = {
    apiKey: {
      findFirst: (...a: unknown[]) => findFirst(...a),
      update: (...a: unknown[]) => update(...a),
    },
  };

  beforeEach(() => {
    findFirst = jest.fn();
    update = jest.fn().mockResolvedValue({});
    service = new ApiKeysService(prisma as never);
  });

  it('rejects a key without the ak_ prefix without hitting the DB', async () => {
    const res = await service.validate('not-a-key');
    expect(res).toBeNull();
    expect(findFirst).not.toHaveBeenCalled();
  });

  it('validates an active, unexpired key by its sha256 hash and stamps lastUsedAt', async () => {
    const key = 'ak_' + 'x'.repeat(20);
    const expectedHash = service.hashKey(key);
    findFirst.mockResolvedValue({
      id: 'k-1',
      clientId: 'gateway',
      scopes: ['gateway:invoke'],
      expiresAt: null,
    });

    const res = await service.validate(key);

    expect(res).toEqual({ id: 'k-1', clientId: 'gateway', scopes: ['gateway:invoke'] });
    // Lookup is scoped to active keys and keyed on the hash (never the plaintext).
    expect(findFirst).toHaveBeenCalledWith({ where: { keyHash: expectedHash, isActive: true } });
    expect(update).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'k-1' } }));
  });

  it('treats a revoked (inactive) key as invalid — findFirst filters isActive:true and returns null', async () => {
    const key = 'ak_' + 'y'.repeat(20);
    findFirst.mockResolvedValue(null); // no active row matches
    const res = await service.validate(key);
    expect(res).toBeNull();
    expect(update).not.toHaveBeenCalled();
  });

  it('rejects an expired key (expiresAt in the past)', async () => {
    const key = 'ak_' + 'z'.repeat(20);
    findFirst.mockResolvedValue({
      id: 'k-exp',
      clientId: null,
      scopes: ['gateway:invoke'],
      expiresAt: new Date(Date.now() - 1000),
    });
    const res = await service.validate(key);
    expect(res).toBeNull();
    // Expired key must not be marked used.
    expect(update).not.toHaveBeenCalled();
  });

  it('accepts a key whose expiry is in the future', async () => {
    const key = 'ak_' + 'w'.repeat(20);
    findFirst.mockResolvedValue({
      id: 'k-fut',
      clientId: null,
      scopes: ['gateway:invoke'],
      expiresAt: new Date(Date.now() + 60_000),
    });
    const res = await service.validate(key);
    expect(res).toMatchObject({ id: 'k-fut' });
  });
});

describe('ApiKeysService registry and lifecycle queries', () => {
  let findMany: jest.Mock;
  let update: jest.Mock;
  let create: jest.Mock;
  let service: ApiKeysService;

  beforeEach(() => {
    findMany = jest.fn();
    update = jest.fn().mockResolvedValue({});
    create = jest.fn().mockResolvedValue({ id: 'new-id' });
    service = new ApiKeysService({
      apiKey: { findMany, update, create, findFirst: jest.fn() },
    } as never);
  });

  it('revoke marks the key inactive', async () => {
    await service.revoke('k-revoke');
    expect(update).toHaveBeenCalledWith({
      where: { id: 'k-revoke' },
      data: { isActive: false },
    });
  });

  it('listRegistry returns metadata rows ordered for admin UI', async () => {
    const row = {
      id: 'k-1',
      name: 'Gateway',
      keyPrefix: 'ak_abcd',
      scopes: ['gateway:invoke'],
      expiresAt: null,
      lastUsedAt: null,
      isActive: true,
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
    };
    findMany.mockResolvedValue([row]);
    await expect(service.listRegistry()).resolves.toEqual([row]);
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        orderBy: [{ isActive: 'desc' }, { expiresAt: 'asc' }, { name: 'asc' }],
      }),
    );
  });

  it('findExpiringWithin returns active keys expiring before the horizon', async () => {
    const now = new Date('2026-06-01T00:00:00.000Z');
    const expiresAt = new Date('2026-06-10T00:00:00.000Z');
    findMany.mockResolvedValue([{ id: 'k1', name: 'Soon', keyPrefix: 'ak_soon', expiresAt }]);
    const rows = await service.findExpiringWithin(14, now);
    expect(rows).toEqual([{ id: 'k1', name: 'Soon', keyPrefix: 'ak_soon', expiresAt }]);
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          isActive: true,
          expiresAt: expect.objectContaining({ gt: now }),
        }),
      }),
    );
  });

  it('findExpiredActive returns active keys past expiry', async () => {
    const now = new Date('2026-06-01T00:00:00.000Z');
    const expiresAt = new Date('2026-05-01T00:00:00.000Z');
    findMany.mockResolvedValue([{ id: 'k-old', name: 'Old', keyPrefix: 'ak_old', expiresAt }]);
    const rows = await service.findExpiredActive(now);
    expect(rows).toEqual([{ id: 'k-old', name: 'Old', keyPrefix: 'ak_old', expiresAt }]);
  });
});

describe('ApiKeyGrpcController.ValidateServiceApiKey', () => {
  const makeController = (validate: jest.Mock) => new ApiKeyGrpcController({ validate } as never);

  it('returns active with the key id for a key carrying the gateway:invoke scope', async () => {
    const validate = jest.fn().mockResolvedValue({
      id: 'k-1',
      clientId: 'gateway',
      scopes: ['gateway:invoke'],
    });
    const res = await makeController(validate).validateServiceApiKey({ api_key: 'ak_valid' });
    expect(res).toEqual({ active: true, key_id: 'k-1', scopes: ['gateway:invoke'] });
    expect(validate).toHaveBeenCalledWith('ak_valid');
  });

  it('is inactive for an empty key (no validate call)', async () => {
    const validate = jest.fn();
    const res = await makeController(validate).validateServiceApiKey({ api_key: '  ' });
    expect(res).toEqual({ active: false, key_id: '', scopes: [] });
    expect(validate).not.toHaveBeenCalled();
  });

  it('is inactive for a valid key that lacks the gateway:invoke scope (wrong-purpose key)', async () => {
    const validate = jest.fn().mockResolvedValue({
      id: 'k-2',
      clientId: 'other',
      scopes: ['some:other:scope'],
    });
    const res = await makeController(validate).validateServiceApiKey({ apiKey: 'ak_other' });
    expect(res).toEqual({ active: false, key_id: '', scopes: [] });
  });

  it('is inactive when the key does not validate (revoked/unknown)', async () => {
    const validate = jest.fn().mockResolvedValue(null);
    const res = await makeController(validate).validateServiceApiKey({ api_key: 'ak_revoked' });
    expect(res).toEqual({ active: false, key_id: '', scopes: [] });
  });
});

describe('ApiKeyGrpcController.ListServiceApiKeys', () => {
  it('maps registry rows to snake_case wire fields', async () => {
    const created = new Date('2026-01-01T00:00:00.000Z');
    const listRegistry = jest.fn().mockResolvedValue([
      {
        id: 'k-1',
        name: 'Gateway',
        keyPrefix: 'ak_abcd',
        scopes: ['gateway:invoke'],
        expiresAt: null,
        lastUsedAt: new Date('2026-01-02T00:00:00.000Z'),
        isActive: true,
        createdAt: created,
      },
    ]);
    const c = new ApiKeyGrpcController({ listRegistry } as never);
    const res = await c.listServiceApiKeys();
    expect(listRegistry).toHaveBeenCalled();
    expect(res.keys[0]).toEqual({
      id: 'k-1',
      name: 'Gateway',
      key_prefix: 'ak_abcd',
      scopes: ['gateway:invoke'],
      expires_at: '',
      last_used_at: '2026-01-02T00:00:00.000Z',
      is_active: true,
      created_at: '2026-01-01T00:00:00.000Z',
    });
  });
});

describe('GrpcGatewayKeyGuard', () => {
  const SKIP_GATEWAY_KEY = 'skipGatewayKey';
  const _REQUIRE_KEY_SCOPES = 'requireKeyScopes'; // documented metadata key (unused directly)

  // Reflector that returns per-metadata-key values (skip flag / required-scopes meta).
  const makeReflector = (opts: { skip?: boolean; require?: unknown } = {}) => ({
    getAllAndOverride: jest.fn((k: string) =>
      k === SKIP_GATEWAY_KEY ? (opts.skip ?? false) : (opts.require ?? undefined),
    ),
  });

  const makeMetadata = (value?: string) => ({
    get: (k: string) => (k === GW_METADATA.SERVICE_API_KEY && value !== undefined ? [value] : []),
  });

  const makeContext = (metadata: unknown, type: 'rpc' | 'http' = 'rpc') =>
    ({
      getType: () => type,
      getHandler: () => ({ name: 'resolveUsers' }),
      getClass: () => ({ name: 'AuthGrpcController' }),
      getArgByIndex: (i: number) => (i === 1 ? metadata : undefined),
    }) as never;

  it('rejects with UNAUTHENTICATED when the service-api-key metadata is missing', async () => {
    const guard = new GrpcGatewayKeyGuard(
      { validate: jest.fn() } as never,
      makeReflector() as never,
    );
    await expect(guard.canActivate(makeContext(makeMetadata(undefined)))).rejects.toMatchObject({
      error: { message: 'Missing x-service-api-key' },
    });
  });

  it('rejects an invalid/revoked key (validate → null) with UNAUTHENTICATED', async () => {
    const validate = jest.fn().mockResolvedValue(null);
    const guard = new GrpcGatewayKeyGuard({ validate } as never, makeReflector() as never);
    await expect(guard.canActivate(makeContext(makeMetadata('ak_bad')))).rejects.toMatchObject({
      error: { message: 'Invalid or insufficient service API key' },
    });
  });

  it('rejects a key that validates but lacks the default gateway:invoke scope', async () => {
    const validate = jest.fn().mockResolvedValue({ id: 'k', clientId: null, scopes: ['x'] });
    const guard = new GrpcGatewayKeyGuard({ validate } as never, makeReflector() as never);
    await expect(
      guard.canActivate(makeContext(makeMetadata('ak_scopeless'))),
    ).rejects.toMatchObject({ error: { message: 'Invalid or insufficient service API key' } });
  });

  it('accepts a valid gateway key and trims surrounding whitespace before validating', async () => {
    const validate = jest.fn().mockResolvedValue({
      id: 'k',
      clientId: 'gateway',
      scopes: ['gateway:invoke'],
    });
    const guard = new GrpcGatewayKeyGuard({ validate } as never, makeReflector() as never);
    await expect(guard.canActivate(makeContext(makeMetadata('  ak_ok  ')))).resolves.toBe(true);
    expect(validate).toHaveBeenCalledWith('ak_ok');
  });

  it('skips the check entirely for non-rpc contexts', async () => {
    const validate = jest.fn();
    const guard = new GrpcGatewayKeyGuard({ validate } as never, makeReflector() as never);
    await expect(guard.canActivate(makeContext(makeMetadata('ak_ok'), 'http'))).resolves.toBe(true);
    expect(validate).not.toHaveBeenCalled();
  });

  it('honours @SkipGatewayKey (reflector skip=true) and bypasses validation', async () => {
    const validate = jest.fn();
    const guard = new GrpcGatewayKeyGuard(
      { validate } as never,
      makeReflector({ skip: true }) as never,
    );
    await expect(guard.canActivate(makeContext(makeMetadata(undefined)))).resolves.toBe(true);
    expect(validate).not.toHaveBeenCalled();
  });

  // ── @RequireKeyScopes: scope matrix ───────────────────────────────────────
  it('accepts a key carrying ANY of the handler-required scopes (internal:user-directory)', async () => {
    const validate = jest.fn().mockResolvedValue({
      id: 'k',
      clientId: 'notification',
      scopes: ['internal:user-directory'],
    });
    const guard = new GrpcGatewayKeyGuard(
      { validate } as never,
      makeReflector({
        require: { scopes: ['gateway:invoke', 'internal:user-directory'] },
      }) as never,
    );
    await expect(guard.canActivate(makeContext(makeMetadata('ak_dir')))).resolves.toBe(true);
  });

  it('accepts a gateway:invoke key on a handler that ALSO allows internal:user-directory', async () => {
    const validate = jest
      .fn()
      .mockResolvedValue({ id: 'k', clientId: 'gateway', scopes: ['gateway:invoke'] });
    const guard = new GrpcGatewayKeyGuard(
      { validate } as never,
      makeReflector({
        require: { scopes: ['gateway:invoke', 'internal:user-directory'] },
      }) as never,
    );
    await expect(guard.canActivate(makeContext(makeMetadata('ak_gw')))).resolves.toBe(true);
  });

  it('rejects an internal:user-directory key on a handler requiring gateway:invoke (scope isolation)', async () => {
    const validate = jest.fn().mockResolvedValue({
      id: 'k',
      clientId: 'notification',
      scopes: ['internal:user-directory'],
    });
    const guard = new GrpcGatewayKeyGuard(
      { validate } as never,
      makeReflector({ require: { scopes: ['gateway:invoke'] } }) as never,
    );
    await expect(guard.canActivate(makeContext(makeMetadata('ak_dir')))).rejects.toMatchObject({
      error: { message: 'Invalid or insufficient service API key' },
    });
  });

  // ── soft-enforce feature flag ─────────────────────────────────────────────
  const FLAG = 'REQUIRE_KEY_FOR_RESOLVE_USERS';
  const softMeta = {
    scopes: ['gateway:invoke', 'internal:user-directory'],
    softEnforceEnv: FLAG,
  };
  afterEach(() => {
    delete process.env[FLAG];
  });

  it('flag unset (BOX default): fail-closed — rejects a missing key', async () => {
    const validate = jest.fn();
    const guard = new GrpcGatewayKeyGuard(
      { validate } as never,
      makeReflector({ require: softMeta }) as never,
    );
    await expect(guard.canActivate(makeContext(makeMetadata(undefined)))).rejects.toMatchObject({
      error: { message: 'Missing x-service-api-key' },
    });
    expect(validate).not.toHaveBeenCalled();
  });

  it('flag=false: soft mode allows a MISSING key (staged-rollout escape hatch)', async () => {
    process.env[FLAG] = 'false';
    const validate = jest.fn();
    const guard = new GrpcGatewayKeyGuard(
      { validate } as never,
      makeReflector({ require: softMeta }) as never,
    );
    await expect(guard.canActivate(makeContext(makeMetadata(undefined)))).resolves.toBe(true);
    expect(validate).not.toHaveBeenCalled();
  });

  it('flag=false: soft mode allows an INVALID key', async () => {
    process.env[FLAG] = 'false';
    const validate = jest.fn().mockResolvedValue(null);
    const guard = new GrpcGatewayKeyGuard(
      { validate } as never,
      makeReflector({ require: softMeta }) as never,
    );
    await expect(guard.canActivate(makeContext(makeMetadata('ak_bad')))).resolves.toBe(true);
  });

  it('flag=true: enforces (fail-closed) — rejects a missing key', async () => {
    process.env[FLAG] = 'true';
    const guard = new GrpcGatewayKeyGuard(
      { validate: jest.fn() } as never,
      makeReflector({ require: softMeta }) as never,
    );
    await expect(guard.canActivate(makeContext(makeMetadata(undefined)))).rejects.toMatchObject({
      error: { message: 'Missing x-service-api-key' },
    });
  });

  it('flag=true: still accepts a valid scoped key', async () => {
    process.env[FLAG] = 'true';
    const validate = jest
      .fn()
      .mockResolvedValue({ id: 'k', clientId: 'control', scopes: ['internal:user-directory'] });
    const guard = new GrpcGatewayKeyGuard(
      { validate } as never,
      makeReflector({ require: softMeta }) as never,
    );
    await expect(guard.canActivate(makeContext(makeMetadata('ak_dir')))).resolves.toBe(true);
  });
});
