import { ModuleLifecycleService } from './module-lifecycle.service';
import { ProjectsService } from './projects.service';
import { MutationIdempotencyService } from '../idempotency/mutation-idempotency.service';
import { AutomationLifecycleService } from '../provisioning/automation-lifecycle.service';
import type { ProjectModuleConfig } from '@fairflow/shared';

/**
 * the box stand repro: owner enables «Документы» / «Чат» from project settings while
 * products/reports/automation/search are already on. Those modules have never been
 * installed (no row in moduleConfigs) — only the already-enabled set is stored.
 * FE (fe-merge) calls POST .../enable, not PATCH updateProject.
 */
describe('ModuleLifecycleService.enable — documents/chat without install fact', () => {
  const projects = {
    findOne: jest.fn(),
    update: jest.fn(),
  } as unknown as ProjectsService;
  const automationLifecycle = {
    resumePausedDlq: jest.fn(),
    unfreezeRules: jest.fn(),
    syncModuleTransitions: jest.fn(),
  } as unknown as AutomationLifecycleService;
  const idempotency = new MutationIdempotencyService();
  const service = new ModuleLifecycleService(projects, idempotency, automationLifecycle);

  const boxEnabledConfigs: ProjectModuleConfig[] = [
    'deals',
    'contacts',
    'companies',
    'products',
    'reports',
    'automation',
    'search',
  ].map((moduleId) => ({
    moduleId,
    enabled: true,
    installed: true,
    personalSettings: {},
    integrationSettings: {},
    integrationMethodsEnabled: [],
  }));

  beforeEach(() => {
    jest.clearAllMocks();
    (projects.findOne as jest.Mock).mockResolvedValue({ moduleConfigs: boxEnabledConfigs });
    (projects.update as jest.Mock).mockImplementation(async (_id, data) => ({
      moduleConfigs: data.moduleConfigs,
    }));
  });

  it.each(['documents', 'chat'])(
    'enable(%s) succeeds when the module was never installed (implicit install, the box stand)',
    async (moduleId) => {
      const result = await service.enable('p1', moduleId, 'owner-1');

      expect(result.enabled).toBe(true);
      expect(result.installed).toBe(true);
      expect(projects.update).toHaveBeenCalledWith(
        'p1',
        expect.objectContaining({
          moduleConfigs: expect.arrayContaining([
            expect.objectContaining({ moduleId, enabled: true, installed: true }),
          ]),
        }),
        'owner-1',
      );
    },
  );

  it('enable(orders) without install fact also succeeds — general regression, not documents/chat-only', async () => {
    const result = await service.enable('p1', 'orders', 'owner-1');
    expect(result.enabled).toBe(true);
    expect(result.installed).toBe(true);
  });

  it('mapError duck-types ModuleLifecycleError when instanceof fails (Internal error guard)', async () => {
    const fake = Object.assign(new Error('Module documents is not installed in the space'), {
      name: 'ModuleLifecycleError',
      code: 'MODULE_NOT_INSTALLED',
    });
    (projects.findOne as jest.Mock).mockRejectedValue(fake);

    await expect(service.enable('p1', 'documents', 'owner-1')).rejects.toMatchObject({
      name: 'AppError',
      errorCode: 'locked',
      message: 'Module documents is not installed in the space',
    });
  });
});
