import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Metadata, status as GrpcStatus } from '@grpc/grpc-js';
import { RpcException } from '@nestjs/microservices';
import { Test, TestingModule } from '@nestjs/testing';
import { firstValueFrom } from 'rxjs';
import { GW_METADATA, grpcStatusToHttp, RpcAppExceptionFilter } from '@fairflow/shared';
import { ProjectsService } from './projects.service';
import { ModuleLifecycleService } from './module-lifecycle.service';
import { MutationIdempotencyService } from '../idempotency/mutation-idempotency.service';
import { MemberOwnedRecordsService } from './member-owned-records.service';
import { PrismaService } from '../prisma/prisma.service';
import { ProjectProvisioningService } from '../provisioning/project-provisioning.service';
import { AutomationLifecycleService } from '../provisioning/automation-lifecycle.service';
import { ControlEventEmitter } from '../outbox/control-event.emitter';
import { RoleAuditService } from '../outbox/role-audit.service';
import type { ProjectModuleConfig } from '@fairflow/shared';

/**
 * Project-settings wave — `ProjectsService.update` is the single write path for
 * the module composition of a project, and it was missing four things at once:
 *
 *  - TODO-085: its own PEP (it could rewrite modules/policies/visibility with no
 *    check on the actor);
 *  - TODO-237: the lifecycle state (`installed`/`version`) survived neither the
 *    wire nor the merge, so every PATCH erased what install/upgrade had written;
 *  - TODO-239: no enable/disable/install/uninstall/upgrade transition reached
 *    the audit chain or the bus;
 *  - TODO-240: disabling a dependency silently cascade-disabled everything that
 *    depended on it, with no signal to the user.
 */
describe('ProjectsService.update — module lifecycle & PEP', () => {
  let service: ProjectsService;
  let lifecycle: ModuleLifecycleService;
  let prisma: {
    project: { findUnique: jest.Mock; update: jest.Mock };
    projectMember: { findUnique: jest.Mock; findMany: jest.Mock };
    $transaction: jest.Mock;
  };
  let roleAudit: { append: jest.Mock };
  let events: { emit: jest.Mock };
  let automationLifecycle: {
    syncModuleTransitions: jest.Mock;
    syncArchiveTransition: jest.Mock;
  };
  let provisioning: { provisionFromTemplate: jest.Mock };

  const ACTOR = 'owner-1';

  /** Store a project row; `enrichProject` normalizes the configs on read. */
  const givenProject = (modules: string[], moduleConfigs: ProjectModuleConfig[]) => {
    const row = {
      id: 'p1',
      ownerId: 'org-1',
      name: 'P1',
      templateId: null,
      modules,
      moduleConfigs,
      modulePolicies: [],
      visibilityConfig: {},
      isArchived: false,
      createdAt: new Date(),
      updatedAt: new Date(),
      members: [],
    };
    prisma.project.findUnique.mockResolvedValue(row);
    prisma.project.update.mockImplementation(({ data }: { data: Record<string, unknown> }) => ({
      ...row,
      ...data,
    }));
  };

  /** The `moduleConfigs` the service actually persisted. */
  const savedConfigs = (): ProjectModuleConfig[] =>
    (prisma.project.update.mock.calls[0][0] as { data: { moduleConfigs: ProjectModuleConfig[] } })
      .data.moduleConfigs;

  const cfg = (
    moduleId: string,
    enabled: boolean,
    extra: Partial<ProjectModuleConfig> = {},
  ): ProjectModuleConfig => ({
    moduleId,
    enabled,
    personalSettings: {},
    integrationSettings: {},
    integrationMethodsEnabled: [],
    ...extra,
  });

  beforeEach(async () => {
    prisma = {
      project: { findUnique: jest.fn(), update: jest.fn() },
      // Default the actor to project owner; the fail-closed tests override it.
      projectMember: {
        findUnique: jest.fn().mockResolvedValue({ role: 'owner' }),
        findMany: jest.fn().mockResolvedValue([]),
      },
      $transaction: jest.fn(async (cb: (tx: unknown) => unknown) => cb(prisma)),
    };
    roleAudit = { append: jest.fn().mockResolvedValue('audit-1') };
    events = { emit: jest.fn().mockResolvedValue(undefined) };
    automationLifecycle = {
      syncModuleTransitions: jest.fn().mockResolvedValue(undefined),
      syncArchiveTransition: jest.fn().mockResolvedValue(undefined),
    };
    provisioning = { provisionFromTemplate: jest.fn().mockResolvedValue(undefined) };
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        MutationIdempotencyService,
        ProjectsService,
        ModuleLifecycleService,
        { provide: PrismaService, useValue: prisma },
        {
          provide: ProjectProvisioningService,
          useValue: provisioning,
        },
        {
          provide: AutomationLifecycleService,
          useValue: automationLifecycle,
        },
        { provide: ControlEventEmitter, useValue: events },
        { provide: RoleAuditService, useValue: roleAudit },
        {
          provide: MemberOwnedRecordsService,
          useValue: {
            countOwned: jest.fn().mockResolvedValue({ total: 0, breakdown: [] }),
            reassignOwned: jest.fn(),
          },
        },
      ],
    }).compile();
    service = module.get(ProjectsService);
    lifecycle = module.get(ModuleLifecycleService);
  });

  // ─── TODO-085: the missing PEP ──────────────────────────────────────────────

  describe('PEP (TODO-085)', () => {
    it('denies an anonymous update — fail-closed, nothing written', async () => {
      givenProject(['deals'], []);
      await expect(service.update('p1', { name: 'renamed' })).rejects.toMatchObject({
        errorCode: 'auth',
      });
      expect(prisma.project.update).not.toHaveBeenCalled();
    });

    it('denies a member without project `manage` (viewer cannot rewrite modules)', async () => {
      givenProject(['deals'], []);
      prisma.projectMember.findUnique.mockResolvedValue({ role: 'viewer' });
      await expect(
        service.update('p1', { modules: ['deals', 'contacts'] }, 'viewer-1'),
      ).rejects.toMatchObject({ errorCode: 'access' });
      expect(prisma.project.update).not.toHaveBeenCalled();
    });

    it('denies a non-member of THIS project (no cross-project escalation)', async () => {
      givenProject(['deals'], []);
      prisma.projectMember.findUnique.mockResolvedValue(null);
      await expect(
        service.update('p1', { visibilityConfig: { owner: 'all' } }, 'stranger'),
      ).rejects.toMatchObject({ errorCode: 'access' });
      expect(prisma.project.update).not.toHaveBeenCalled();
    });

    it('allows an owner and scopes the membership lookup to (project, actor)', async () => {
      givenProject(['deals'], []);
      await service.update('p1', { name: 'renamed' }, ACTOR);
      expect(prisma.projectMember.findUnique).toHaveBeenCalledWith({
        where: { projectId_userId: { projectId: 'p1', userId: ACTOR } },
        select: { role: true },
      });
      expect(prisma.project.update).toHaveBeenCalled();
    });

    it('the lifecycle path threads the actor through instead of calling anonymously', async () => {
      givenProject(['deals'], []);
      const spy = jest.spyOn(service, 'update');
      await lifecycle.install('p1', 'contacts', ACTOR);
      expect(spy).toHaveBeenCalledWith('p1', expect.anything(), ACTOR);
    });

    it('an anonymous lifecycle call fails closed at the domain PEP', async () => {
      givenProject(['deals'], []);
      await expect(lifecycle.install('p1', 'contacts')).rejects.toMatchObject({
        errorCode: 'auth',
      });
      expect(prisma.project.update).not.toHaveBeenCalled();
    });
  });

  // ─── TODO-237: lifecycle state survives a PATCH ─────────────────────────────

  describe('installed/version merge (TODO-237)', () => {
    it('keeps the stored install fact + version when the PATCH omits them', async () => {
      givenProject(['deals'], [cfg('contacts', false, { installed: true, version: '2.1.0' })]);

      // A client that does not know about lifecycle fields round-trips the
      // config list without them — this used to erase both.
      await service.update('p1', { moduleConfigs: [cfg('contacts', false)] }, ACTOR);

      const contacts = savedConfigs().find((c) => c.moduleId === 'contacts');
      expect(contacts).toMatchObject({ enabled: false, installed: true, version: '2.1.0' });
    });

    it('an explicit installed:false (uninstall) still wins over the stored fact', async () => {
      givenProject(['deals'], [cfg('contacts', false, { installed: true, version: '2.1.0' })]);

      await service.update(
        'p1',
        { moduleConfigs: [cfg('contacts', false, { installed: false })] },
        ACTOR,
      );

      const contacts = savedConfigs().find((c) => c.moduleId === 'contacts');
      expect(contacts?.installed).toBe(false);
    });

    it('a partial PATCH keeps the configs it does not mention', async () => {
      // The FE may send only the modules it is changing. Replacing the list
      // wholesale would drop `contacts` entirely — install fact, version and
      // settings with it — and would also fabricate an `uninstalled` fact.
      givenProject(
        ['deals'],
        [
          cfg('deals', true),
          cfg('contacts', false, {
            installed: true,
            version: '2.1.0',
            personalSettings: { defaultView: 'grid' },
            integrationMethodsEnabled: ['contacts.read'],
          }),
        ],
      );

      await service.update('p1', { moduleConfigs: [cfg('deals', true)] }, ACTOR);

      expect(savedConfigs().find((c) => c.moduleId === 'contacts')).toMatchObject({
        enabled: false,
        installed: true,
        version: '2.1.0',
        personalSettings: { defaultView: 'grid' },
        integrationMethodsEnabled: ['contacts.read'],
      });
      expect(roleAudit.append).not.toHaveBeenCalled();
    });

    it('an incoming version wins over the stored one (upgrade)', async () => {
      givenProject(['deals'], [cfg('contacts', true, { installed: true, version: '1.0.0' })]);

      await service.update(
        'p1',
        { moduleConfigs: [cfg('contacts', true, { version: '2.0.0' })] },
        ACTOR,
      );

      expect(savedConfigs().find((c) => c.moduleId === 'contacts')?.version).toBe('2.0.0');
    });
  });

  // ─── TODO-240: no silent dependency cascade ─────────────────────────────────

  describe('dependency cascade refusal (TODO-240)', () => {
    it('refuses to disable a dependency while a dependant stays enabled', async () => {
      // automation → activities (+ deals, locked). TODO-098 made `products`
      // dependency-free and orders→products soft, so the hard edge this refusal
      // protects is now automation's: disabling `activities` used to silently
      // switch `automation` off as well.
      givenProject(
        ['deals', 'activities', 'automation'],
        [cfg('deals', true), cfg('activities', true), cfg('automation', true)],
      );

      await expect(
        service.update(
          'p1',
          {
            moduleConfigs: [cfg('deals', true), cfg('activities', false), cfg('automation', true)],
          },
          ACTOR,
        ),
      ).rejects.toMatchObject({
        errorCode: 'conflict',
        message: 'MODULE_HAS_DEPENDENTS',
        details: {
          code: 'MODULE_HAS_DEPENDENTS',
          moduleId: 'activities',
          dependents: expect.arrayContaining(['automation']),
        },
      });
      expect(prisma.project.update).not.toHaveBeenCalled();
    });

    it('accepts disabling a dependency together with its dependants', async () => {
      givenProject(
        ['deals', 'orders', 'products'],
        [cfg('deals', true), cfg('orders', true), cfg('products', true)],
      );

      await service.update(
        'p1',
        {
          moduleConfigs: [cfg('deals', true), cfg('orders', false), cfg('products', false)],
        },
        ACTOR,
      );

      const saved = savedConfigs();
      expect(saved.find((c) => c.moduleId === 'orders')?.enabled).toBe(false);
      expect(saved.find((c) => c.moduleId === 'products')?.enabled).toBe(false);
    });

    it('does not trip on a locked module the normalizer force-enables anyway', async () => {
      givenProject(['deals', 'orders'], [cfg('deals', true), cfg('orders', true)]);

      // `deals` is locked: a stray `enabled:false` is normalized away, not an error.
      await service.update(
        'p1',
        { moduleConfigs: [cfg('deals', false), cfg('orders', true)] },
        ACTOR,
      );

      expect(savedConfigs().find((c) => c.moduleId === 'deals')?.enabled).toBe(true);
    });

    /**
     * The refusal is only worth anything if its REASON reaches the browser, and
     * control speaks gRPC: the AppError has to leave the process as
     * FAILED_PRECONDITION with `details` in the `x-error-details-bin` trailer —
     * that is what the gateway turns into HTTP 422 + `error.details.dependents`,
     * the exact shape the settings UI reads to list the blocking modules.
     * Until the RPC filter was wired in `control/src/main.ts` this error left Nest
     * raw → gRPC UNKNOWN(2) → HTTP 500 «Internal error» with `details: null`, so
     * the FE dependants branch was unreachable: the domain refused correctly and
     * the explanation never arrived.
     */
    it('crosses the gRPC boundary as FAILED_PRECONDITION with dependents in the details trailer', async () => {
      givenProject(
        ['deals', 'activities', 'automation'],
        [cfg('deals', true), cfg('activities', true), cfg('automation', true)],
      );

      const raised = await service
        .update(
          'p1',
          {
            moduleConfigs: [cfg('deals', true), cfg('activities', false), cfg('automation', true)],
          },
          ACTOR,
        )
        .then(
          () => undefined,
          (e: unknown) => e,
        );
      expect(raised).toBeDefined();

      // Same filter instance main.ts binds on the microservice.
      let wire: { code: number; message: string; metadata?: Metadata } | undefined;
      try {
        await firstValueFrom(new RpcAppExceptionFilter().catch(raised, {} as never));
      } catch (e) {
        wire = (e instanceof RpcException ? e.getError() : e) as typeof wire;
      }

      expect(wire?.code).toBe(GrpcStatus.ALREADY_EXISTS);
      expect(grpcStatusToHttp(wire!.code)).toBe(409);
      const bin = wire?.metadata?.get(GW_METADATA.ERROR_DETAILS)[0] as Buffer | undefined;
      expect(bin).toBeDefined();
      expect(JSON.parse(bin!.toString('utf8'))).toEqual({
        code: 'MODULE_HAS_DEPENDENTS',
        moduleId: 'activities',
        dependents: expect.arrayContaining(['automation']),
      });
    });

    it('has the RPC exception filter actually bound on the control microservice', () => {
      // Guards the wiring the test above assumes: without this line every control
      // AppError ('locked' cascade, 'auth'/'access' PEP refusals) degrades to a
      // generic HTTP 500 at the gateway.
      const main = readFileSync(join(__dirname, '..', 'main.ts'), 'utf8');
      expect(main).toMatch(/microservice\.useGlobalFilters\(new RpcAppExceptionFilter\(\)\)/);
    });
  });

  // ─── TODO-239: transitions reach the audit chain + the bus ──────────────────

  describe('lifecycle audit facts (TODO-239)', () => {
    const factsFor = (routingKey: string) =>
      roleAudit.append.mock.calls
        .map((c) => c[1] as { routingKey?: string; entityId?: string })
        .filter((e) => e.routingKey === routingKey);

    it('chains control.module.enabled when a module is switched on', async () => {
      givenProject(['deals'], [cfg('deals', true)]);

      await service.update(
        'p1',
        { moduleConfigs: [cfg('deals', true), cfg('contacts', true)] },
        ACTOR,
      );

      expect(factsFor('control.module.enabled')).toEqual([
        expect.objectContaining({
          projectId: 'p1',
          actorUserId: ACTOR,
          action: 'module.enabled',
          entityType: 'module',
          entityId: 'contacts',
        }),
      ]);
      // Enabling implies installing — that fact is chained too.
      expect(factsFor('control.module.installed')).toHaveLength(1);
    });

    it('chains control.module.disabled when a module is switched off', async () => {
      givenProject(['deals', 'contacts'], [cfg('deals', true), cfg('contacts', true)]);

      await service.update(
        'p1',
        { moduleConfigs: [cfg('deals', true), cfg('contacts', false)] },
        ACTOR,
      );

      expect(factsFor('control.module.disabled')).toEqual([
        expect.objectContaining({ action: 'module.disabled', entityId: 'contacts' }),
      ]);
    });

    it('TODO-283: syncs automation lifecycle when automation module disabled', async () => {
      givenProject(['deals', 'automation'], [cfg('deals', true), cfg('automation', true)]);

      await service.update(
        'p1',
        { moduleConfigs: [cfg('deals', true), cfg('automation', false)] },
        ACTOR,
      );

      expect(automationLifecycle.syncModuleTransitions).toHaveBeenCalledWith(
        'p1',
        expect.arrayContaining([
          expect.objectContaining({
            routingKey: 'control.module.disabled',
            moduleId: 'automation',
          }),
        ]),
        expect.any(Array),
        expect.any(Array),
      );
    });

    it('chains control.module.runtime_resumed with DLQ fate (FR-PLATFORM-115)', async () => {
      givenProject(
        ['automation'],
        [
          cfg('automation', true, {
            runtimeStatus: 'suspended',
            everSuspended: true,
            configState: 'ready',
            integrationSettings: { defaultWebhookSecret: 'x' },
          }),
        ],
      );

      await service.update(
        'p1',
        {
          moduleConfigs: [
            cfg('automation', true, {
              runtimeStatus: 'active',
              everSuspended: true,
              configState: 'ready',
              integrationSettings: { defaultWebhookSecret: 'x' },
            }),
          ],
          runtimeResume: { moduleId: 'automation', dlq: 'deliver' },
        },
        ACTOR,
      );

      expect(factsFor('control.module.runtime_resumed')).toEqual([
        expect.objectContaining({
          action: 'module.runtime_resumed',
          entityId: 'automation',
          after: expect.objectContaining({ runtimeStatus: 'active', dlq: 'deliver' }),
        }),
      ]);
    });

    it('chains control.module.upgraded when the active version moves', async () => {
      givenProject(
        ['deals', 'contacts'],
        [cfg('deals', true), cfg('contacts', true, { installed: true, version: '1.0.0' })],
      );

      await service.update(
        'p1',
        {
          moduleConfigs: [
            cfg('deals', true),
            cfg('contacts', true, { installed: true, version: '2.0.0' }),
          ],
        },
        ACTOR,
      );

      expect(factsFor('control.module.upgraded')).toEqual([
        expect.objectContaining({
          action: 'module.upgraded',
          entityId: 'contacts',
          before: { moduleId: 'contacts', version: '1.0.0' },
          after: { moduleId: 'contacts', version: '2.0.0' },
        }),
      ]);
    });

    it('chains control.module.uninstalled when the install fact is dropped', async () => {
      givenProject(
        ['deals'],
        [cfg('deals', true), cfg('contacts', false, { installed: true, version: '1.0.0' })],
      );

      await service.update(
        'p1',
        { moduleConfigs: [cfg('deals', true), cfg('contacts', false, { installed: false })] },
        ACTOR,
      );

      expect(factsFor('control.module.uninstalled')).toEqual([
        expect.objectContaining({ action: 'module.uninstalled', entityId: 'contacts' }),
      ]);
    });

    it('emits nothing when the module composition did not change', async () => {
      givenProject(['deals', 'contacts'], [cfg('deals', true), cfg('contacts', true)]);

      await service.update('p1', { name: 'renamed' }, ACTOR);

      expect(roleAudit.append).not.toHaveBeenCalled();
    });

    it('appends inside the same transaction as the config write', async () => {
      givenProject(['deals'], [cfg('deals', true)]);

      await service.update(
        'p1',
        { moduleConfigs: [cfg('deals', true), cfg('contacts', true)] },
        ACTOR,
      );

      expect(prisma.$transaction).toHaveBeenCalledTimes(1);
      // The chain writer receives the transaction client, not the root prisma.
      expect(roleAudit.append.mock.calls[0][0]).toBe(prisma);
    });
  });

  describe('FR-PSET-055 cascade disable', () => {
    it('cascade=true disables enabled dependents together with the target module', async () => {
      givenProject(
        ['deals', 'activities', 'automation'],
        [cfg('deals', true), cfg('activities', true), cfg('automation', true)],
      );

      await service.update(
        'p1',
        {
          moduleConfigs: [cfg('deals', true), cfg('activities', false), cfg('automation', true)],
          cascade: true,
        },
        ACTOR,
      );

      const saved = savedConfigs();
      expect(saved.find((c) => c.moduleId === 'activities')?.enabled).toBe(false);
      expect(saved.find((c) => c.moduleId === 'automation')?.enabled).toBe(false);
    });
  });

  describe('FR-PSET-505 orders lazy provisioning', () => {
    it('calls provisionFromTemplate when orders is enabled post-create', async () => {
      givenProject(['deals'], [cfg('deals', true), cfg('orders', false)]);
      prisma.project.findUnique.mockResolvedValue({
        id: 'p1',
        ownerId: 'org-1',
        name: 'P1',
        templateId: 'b2b-sales',
        modules: ['deals'],
        moduleConfigs: [cfg('deals', true), cfg('orders', false)],
        modulePolicies: [],
        visibilityConfig: {},
        isArchived: false,
        createdAt: new Date(),
        updatedAt: new Date(),
        members: [],
      });

      await service.update(
        'p1',
        { moduleConfigs: [cfg('deals', true), cfg('orders', true)] },
        ACTOR,
      );

      expect(provisioning.provisionFromTemplate).toHaveBeenCalledWith(
        'p1',
        'b2b-sales',
        expect.arrayContaining(['deals', 'orders']),
      );
    });
  });
});

describe('ProjectsService.setModulePersonalSettings — atomic patch (TODO-449)', () => {
  let service: ProjectsService;
  let prisma: {
    project: { findUnique: jest.Mock; update: jest.Mock };
    projectMember: { findUnique: jest.Mock; findMany: jest.Mock };
    $transaction: jest.Mock;
  };

  const ACTOR = 'owner-1';

  const cfg = (
    moduleId: string,
    enabled: boolean,
    extra: Partial<ProjectModuleConfig> = {},
  ): ProjectModuleConfig => ({
    moduleId,
    enabled,
    personalSettings: {},
    integrationSettings: {},
    integrationMethodsEnabled: [],
    ...extra,
  });

  beforeEach(async () => {
    prisma = {
      project: { findUnique: jest.fn(), update: jest.fn() },
      projectMember: {
        findUnique: jest.fn().mockResolvedValue({ role: 'owner' }),
        findMany: jest.fn().mockResolvedValue([]),
      },
      $transaction: jest.fn(async (cb: (tx: unknown) => unknown, _opts?: unknown) => cb(prisma)),
    };
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        MutationIdempotencyService,
        ProjectsService,
        ModuleLifecycleService,
        { provide: PrismaService, useValue: prisma },
        {
          provide: ProjectProvisioningService,
          useValue: { provisionFromTemplate: jest.fn() },
        },
        {
          provide: AutomationLifecycleService,
          useValue: {
            syncModuleTransitions: jest.fn(),
            syncArchiveTransition: jest.fn(),
          },
        },
        { provide: ControlEventEmitter, useValue: { emit: jest.fn() } },
        { provide: RoleAuditService, useValue: { append: jest.fn() } },
        {
          provide: MemberOwnedRecordsService,
          useValue: {
            countOwned: jest.fn().mockResolvedValue({ total: 0, breakdown: [] }),
            reassignOwned: jest.fn(),
          },
        },
      ],
    }).compile();
    service = module.get(ProjectsService);
  });

  it('updates only the target module personalSettings and keeps siblings intact', async () => {
    const row = {
      id: 'p1',
      ownerId: 'org-1',
      name: 'P1',
      templateId: null,
      modules: ['deals', 'search'],
      moduleConfigs: [
        cfg('deals', true, { personalSettings: { defaultBoard: 'kanban' } }),
        cfg('search', true, { personalSettings: { minQueryChars: 2 } }),
      ],
      modulePolicies: [],
      visibilityConfig: {},
      isArchived: false,
      createdAt: new Date(),
      updatedAt: new Date(),
      members: [],
    };
    prisma.project.findUnique.mockResolvedValue(row);
    prisma.project.update.mockImplementation(({ data }: { data: Record<string, unknown> }) => ({
      ...row,
      ...data,
    }));

    const saved = await service.setModulePersonalSettings(
      'p1',
      'search',
      { minQueryChars: 5, hotkeyEnabled: false },
      ACTOR,
    );

    expect(saved).toMatchObject({ minQueryChars: 5, hotkeyEnabled: false });
    const persisted = (
      prisma.project.update.mock.calls[0][0] as {
        data: { moduleConfigs: ProjectModuleConfig[] };
      }
    ).data.moduleConfigs;
    expect(persisted.find((c) => c.moduleId === 'deals')?.personalSettings).toEqual({
      defaultBoard: 'kanban',
    });
    expect(persisted.find((c) => c.moduleId === 'search')?.personalSettings).toMatchObject({
      minQueryChars: 5,
      hotkeyEnabled: false,
    });
  });
});
