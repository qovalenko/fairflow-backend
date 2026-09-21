import { Test, TestingModule } from '@nestjs/testing';
import { IntegrationsService } from './integrations.service';
import { PrismaService } from '../prisma/prisma.service';
import { revealSecret } from './secret-crypto';

/**
 * BX-INTEG-1: validateApiKey is the PDP for the public API. It must be
 * fail-closed (never leak a project for an absent/revoked key) and must throttle
 * the lastUsedAt bump so a busy key does not write on every request.
 */
describe('IntegrationsService.validateApiKey', () => {
  let service: IntegrationsService;
  let prisma: {
    projectApiKey: { findFirst: jest.Mock; update: jest.Mock };
  };

  beforeEach(async () => {
    prisma = {
      projectApiKey: { findFirst: jest.fn(), update: jest.fn().mockResolvedValue({}) },
    };
    const module: TestingModule = await Test.createTestingModule({
      providers: [IntegrationsService, { provide: PrismaService, useValue: prisma }],
    }).compile();
    service = module.get(IntegrationsService);
  });

  it('denies an empty hash without touching the DB', async () => {
    const r = await service.validateApiKey('  ');
    expect(r).toEqual({ valid: false, projectId: '', keyId: '', name: '', status: '' });
    expect(prisma.projectApiKey.findFirst).not.toHaveBeenCalled();
  });

  it('denies an unknown key (fail-closed, no project leaked)', async () => {
    prisma.projectApiKey.findFirst.mockResolvedValue(null);
    const r = await service.validateApiKey('deadbeef');
    expect(r).toEqual({ valid: false, projectId: '', keyId: '', name: '', status: '' });
    expect(prisma.projectApiKey.update).not.toHaveBeenCalled();
  });

  it('denies a revoked key and does not leak its project', async () => {
    prisma.projectApiKey.findFirst.mockResolvedValue({
      id: 'key-1',
      projectId: 'proj-1',
      name: 'ci',
      status: 'revoked',
      lastUsedAt: null,
    });
    const r = await service.validateApiKey('somehash');
    expect(r).toEqual({ valid: false, projectId: '', keyId: '', name: '', status: '' });
    expect(prisma.projectApiKey.update).not.toHaveBeenCalled();
  });

  it('resolves an active key to its owning project and bumps lastUsedAt when stale', async () => {
    prisma.projectApiKey.findFirst.mockResolvedValue({
      id: 'key-1',
      projectId: 'proj-1',
      name: 'ci',
      status: 'active',
      lastUsedAt: null,
    });
    const r = await service.validateApiKey('somehash');
    expect(r).toEqual({
      valid: true,
      projectId: 'proj-1',
      keyId: 'key-1',
      name: 'ci',
      status: 'active',
    });
    expect(prisma.projectApiKey.findFirst).toHaveBeenCalledWith({
      where: { keyHash: 'somehash' },
      select: { id: true, projectId: true, name: true, status: true, lastUsedAt: true },
    });
    expect(prisma.projectApiKey.update).toHaveBeenCalledWith({
      where: { id: 'key-1' },
      data: { lastUsedAt: expect.any(Date) },
    });
  });

  it('does not bump lastUsedAt when it was refreshed within the throttle window', async () => {
    prisma.projectApiKey.findFirst.mockResolvedValue({
      id: 'key-1',
      projectId: 'proj-1',
      name: 'ci',
      status: 'active',
      lastUsedAt: new Date(), // just now → inside the ~60s throttle
    });
    const r = await service.validateApiKey('somehash');
    expect(r.valid).toBe(true);
    expect(prisma.projectApiKey.update).not.toHaveBeenCalled();
  });

  it('still validates when the lastUsedAt bump fails (best-effort side effect)', async () => {
    prisma.projectApiKey.findFirst.mockResolvedValue({
      id: 'key-1',
      projectId: 'proj-1',
      name: 'ci',
      status: 'active',
      lastUsedAt: null,
    });
    prisma.projectApiKey.update.mockRejectedValue(new Error('db down'));
    const r = await service.validateApiKey('somehash');
    expect(r.valid).toBe(true);
    expect(r.projectId).toBe('proj-1');
  });
});

/**
 * BX-INTEG-3: a REST integration is an outbound-webhook subscription. Its
 * `endpoint` is user-controlled, so it must pass the shared anti-SSRF deny-list
 * at write time, and its `events` filter must be a clean string[]. Non-REST
 * types keep their passthrough config untouched.
 */
describe('IntegrationsService REST config validation', () => {
  let service: IntegrationsService;
  let prisma: {
    projectMember: { findUnique: jest.Mock };
    projectIntegration: { create: jest.Mock; findFirst: jest.Mock; update: jest.Mock };
  };

  const ACTOR = { projectId: 'proj-1', actorUserId: 'admin-1' };

  beforeEach(async () => {
    prisma = {
      projectMember: { findUnique: jest.fn().mockResolvedValue({ role: 'owner' }) },
      projectIntegration: {
        // Echo the persisted row back so mapIntegration has something to map.
        create: jest.fn().mockImplementation(({ data }) => ({
          secret: null,
          status: data.status,
          createdAt: new Date(),
          updatedAt: new Date(),
          ...data,
        })),
        findFirst: jest.fn(),
        update: jest.fn().mockImplementation(({ data }) => ({
          id: 'int-1',
          projectId: ACTOR.projectId,
          name: 'rest',
          type: 'REST',
          secret: null,
          status: 'active',
          createdBy: ACTOR.actorUserId,
          createdAt: new Date(),
          updatedAt: new Date(),
          ...data,
        })),
      },
    };
    const module: TestingModule = await Test.createTestingModule({
      providers: [IntegrationsService, { provide: PrismaService, useValue: prisma }],
    }).compile();
    service = module.get(IntegrationsService);
  });

  it('rejects a REST integration with a private/loopback endpoint (SSRF)', async () => {
    await expect(
      service.createIntegration({
        ...ACTOR,
        name: 'evil',
        type: 'REST',
        config: { endpoint: 'https://127.0.0.1/hook' },
      }),
    ).rejects.toMatchObject({ message: 'WEBHOOK_TARGET_INVALID', details: { reason: 'loopback' } });
    expect(prisma.projectIntegration.create).not.toHaveBeenCalled();
  });

  it('rejects a REST integration with a non-https endpoint', async () => {
    await expect(
      service.createIntegration({
        ...ACTOR,
        name: 'insecure',
        type: 'REST',
        config: { endpoint: 'http://example.com/hook' },
      }),
    ).rejects.toMatchObject({ message: 'WEBHOOK_TARGET_INVALID', details: { reason: 'scheme' } });
  });

  it('requires an endpoint for a REST integration', async () => {
    await expect(
      service.createIntegration({ ...ACTOR, name: 'empty', type: 'REST', config: {} }),
    ).rejects.toMatchObject({ errorCode: 'invalid' });
    expect(prisma.projectIntegration.create).not.toHaveBeenCalled();
  });

  it('accepts a public https endpoint and normalizes the events list (trim + dedupe)', async () => {
    await service.createIntegration({
      ...ACTOR,
      name: 'webhook',
      type: 'REST',
      config: {
        endpoint: 'https://hooks.example.com/x',
        events: ['crm.deal.won', ' crm.deal.won ', 'contact.created'],
      },
    });
    const persisted = prisma.projectIntegration.create.mock.calls[0][0].data.config;
    expect(persisted.endpoint).toBe('https://hooks.example.com/x');
    expect(persisted.events).toEqual(['crm.deal.won', 'contact.created']);
  });

  it('rejects a non-array events field', async () => {
    await expect(
      service.createIntegration({
        ...ACTOR,
        name: 'webhook',
        type: 'REST',
        config: {
          endpoint: 'https://hooks.example.com/x',
          events: 'crm.deal.won' as unknown as string[],
        },
      }),
    ).rejects.toMatchObject({ errorCode: 'invalid' });
  });

  it('leaves non-REST (KAFKA) config untouched — no endpoint required', async () => {
    await service.createIntegration({
      ...ACTOR,
      name: 'bus',
      type: 'KAFKA',
      config: { brokers: 'b1:9092', topic: 't' },
    });
    const persisted = prisma.projectIntegration.create.mock.calls[0][0].data.config;
    expect(persisted).toEqual({ brokers: 'b1:9092', topic: 't' });
  });

  it('re-validates the endpoint when a REST config is replaced on update', async () => {
    prisma.projectIntegration.findFirst.mockResolvedValue({ id: 'int-1', type: 'REST' });
    await expect(
      service.updateIntegration({
        ...ACTOR,
        id: 'int-1',
        config: { endpoint: 'https://169.254.169.254/latest/meta-data' },
      }),
    ).rejects.toMatchObject({ message: 'WEBHOOK_TARGET_INVALID', details: { reason: 'metadata' } });
    expect(prisma.projectIntegration.update).not.toHaveBeenCalled();
  });
});

/**
 * TODO-087: the integration secret must reach the DB encrypted. Before this
 * fix `create`/`update` wrote the raw token/password into `control.
 * project_integrations.secret` and only masked it on the way OUT, so any DB
 * dump was a credential leak.
 */
describe('IntegrationsService secret at rest (TODO-087)', () => {
  let service: IntegrationsService;
  let prisma: {
    projectMember: { findUnique: jest.Mock };
    projectIntegration: { create: jest.Mock; findFirst: jest.Mock; update: jest.Mock };
  };

  const ACTOR = { projectId: 'proj-1', actorUserId: 'admin-1' };
  const KEY = 'FF_SECRET_ENCRYPTION_KEY';
  const originalKey = process.env[KEY];

  const restConfig = { endpoint: 'https://hooks.example.com/ff', events: ['*'] };

  beforeEach(async () => {
    process.env[KEY] = 'a-sufficiently-long-box-passphrase';
    prisma = {
      projectMember: { findUnique: jest.fn().mockResolvedValue({ role: 'owner' }) },
      projectIntegration: {
        create: jest.fn().mockImplementation(({ data }) => ({
          status: data.status,
          createdAt: new Date(),
          updatedAt: new Date(),
          ...data,
        })),
        findFirst: jest.fn().mockResolvedValue({ id: 'int-1', type: 'REST' }),
        update: jest.fn().mockImplementation(({ data }) => ({
          id: 'int-1',
          projectId: ACTOR.projectId,
          name: 'rest',
          type: 'REST',
          secret: null,
          status: 'active',
          createdBy: ACTOR.actorUserId,
          createdAt: new Date(),
          updatedAt: new Date(),
          ...data,
        })),
      },
    };
    const module: TestingModule = await Test.createTestingModule({
      providers: [IntegrationsService, { provide: PrismaService, useValue: prisma }],
    }).compile();
    service = module.get(IntegrationsService);
  });

  afterEach(() => {
    if (originalKey === undefined) delete process.env[KEY];
    else process.env[KEY] = originalKey;
  });

  it('create stores an encrypted envelope, never the plaintext token', async () => {
    const view = await service.createIntegration({
      ...ACTOR,
      name: 'rest',
      type: 'REST',
      config: restConfig,
      secret: 'plaintext-bearer-token',
    });

    const written = prisma.projectIntegration.create.mock.calls[0][0].data as {
      secret: string | null;
    };
    expect(written.secret).toEqual(expect.stringMatching(/^enc:v1:/));
    expect(written.secret).not.toContain('plaintext-bearer-token');
    expect(revealSecret(written.secret)).toBe('plaintext-bearer-token');
    // The read path is unchanged: a set secret is signalled, never echoed.
    expect(view.secretSet).toBe(true);
    expect(view.secretMasked).toBe('••••••••');
  });

  it('update stores an encrypted envelope when the secret is replaced', async () => {
    await service.updateIntegration({
      ...ACTOR,
      id: 'int-1',
      setSecret: true,
      secret: 'rotated-token',
    });

    const written = prisma.projectIntegration.update.mock.calls[0][0].data as {
      secret: string | null;
    };
    expect(written.secret).toEqual(expect.stringMatching(/^enc:v1:/));
    expect(revealSecret(written.secret)).toBe('rotated-token');
  });

  it('clearing the secret still writes NULL (no empty envelope)', async () => {
    await service.updateIntegration({ ...ACTOR, id: 'int-1', setSecret: true, secret: '' });
    const written = prisma.projectIntegration.update.mock.calls[0][0].data as {
      secret: string | null;
    };
    expect(written.secret).toBeNull();
  });

  it('creating WITHOUT a secret needs no key (nothing to encrypt)', async () => {
    delete process.env[KEY];
    const view = await service.createIntegration({
      ...ACTOR,
      name: 'rest',
      type: 'REST',
      config: restConfig,
    });
    expect(view.secretSet).toBe(false);
  });

  it('fail-closed: refuses to persist a secret when no encryption key is set', async () => {
    delete process.env[KEY];
    await expect(
      service.createIntegration({
        ...ACTOR,
        name: 'rest',
        type: 'REST',
        config: restConfig,
        secret: 'plaintext-bearer-token',
      }),
    ).rejects.toMatchObject({ errorCode: 'internal' });
    // The decisive assertion: nothing was written at all — no plaintext fallback.
    expect(prisma.projectIntegration.create).not.toHaveBeenCalled();
  });
});

/**
 * TODO-087: the at-rest key is a deploy-time fact — an operator must find out at
 * BOOT that it is missing, not when the first "save secret" is refused or the
 * first webhook dead-letters.
 */
describe('IntegrationsService startup key check (TODO-087)', () => {
  const KEY = 'FF_SECRET_ENCRYPTION_KEY';
  const originalKey = process.env[KEY];
  let service: IntegrationsService;
  let errorLog: jest.SpyInstance;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [IntegrationsService, { provide: PrismaService, useValue: {} }],
    }).compile();
    service = module.get(IntegrationsService);
    errorLog = jest
      .spyOn((service as unknown as { logger: { error: (m: string) => void } }).logger, 'error')
      .mockImplementation(() => undefined);
  });

  afterEach(() => {
    errorLog.mockRestore();
    if (originalKey === undefined) delete process.env[KEY];
    else process.env[KEY] = originalKey;
  });

  it('logs an ERROR naming the env var when the key is missing', () => {
    delete process.env[KEY];
    service.onModuleInit();
    expect(errorLog).toHaveBeenCalledTimes(1);
    expect(String(errorLog.mock.calls[0][0])).toContain(KEY);
  });

  it('logs an ERROR when the key is present but too weak', () => {
    process.env[KEY] = 'short';
    service.onModuleInit();
    expect(errorLog).toHaveBeenCalledTimes(1);
  });

  it('stays silent when the key is configured', () => {
    process.env[KEY] = 'a-sufficiently-long-box-passphrase';
    service.onModuleInit();
    expect(errorLog).not.toHaveBeenCalled();
  });
});
