import { ModuleLifecycleService } from './module-lifecycle.service';
import { ProjectsService } from './projects.service';
import { MutationIdempotencyService } from '../idempotency/mutation-idempotency.service';
import { AutomationLifecycleService } from '../provisioning/automation-lifecycle.service';

describe('ModuleLifecycleService.enable/disable (FR-PLATFORM-080)', () => {
  const projects = {
    findOne: jest.fn(),
    update: jest.fn(),
  } as unknown as ProjectsService;
  const automationLifecycle = {
    resumePausedDlq: jest.fn(),
    unfreezeRules: jest.fn(),
  } as unknown as AutomationLifecycleService;
  const idempotency = new MutationIdempotencyService();
  const service = new ModuleLifecycleService(projects, idempotency, automationLifecycle);

  beforeEach(() => {
    jest.clearAllMocks();
    (projects.findOne as jest.Mock).mockResolvedValue({
      moduleConfigs: [
        {
          moduleId: 'deals',
          enabled: true,
          installed: true,
          personalSettings: {},
          integrationSettings: {},
          integrationMethodsEnabled: [],
        },
        {
          moduleId: 'orders',
          enabled: false,
          installed: true,
          personalSettings: {},
          integrationSettings: {},
          integrationMethodsEnabled: [],
        },
      ],
    });
    (projects.update as jest.Mock).mockImplementation(async (_id, data) => ({
      moduleConfigs: data.moduleConfigs,
    }));
  });

  it('enable sets enabled=true via ProjectsService.update', async () => {
    const result = await service.enable('p1', 'orders', 'u1', 'idem-enable');

    expect(result.enabled).toBe(true);
    expect(projects.update).toHaveBeenCalledWith(
      'p1',
      expect.objectContaining({
        moduleConfigs: expect.arrayContaining([
          expect.objectContaining({ moduleId: 'orders', enabled: true }),
        ]),
      }),
      'u1',
    );
  });

  it('enable is idempotent when the module is already enabled', async () => {
    await service.enable('p1', 'deals', 'u1');
    expect(projects.update).not.toHaveBeenCalled();
  });

  it('disable passes cascade flag to ProjectsService.update', async () => {
    (projects.findOne as jest.Mock)
      .mockResolvedValueOnce({
        moduleConfigs: [
          {
            moduleId: 'orders',
            enabled: true,
            installed: true,
            personalSettings: {},
            integrationSettings: {},
            integrationMethodsEnabled: [],
          },
        ],
      })
      .mockResolvedValueOnce({
        moduleConfigs: [
          {
            moduleId: 'orders',
            enabled: false,
            installed: true,
            personalSettings: {},
            integrationSettings: {},
            integrationMethodsEnabled: [],
          },
        ],
      });

    const result = await service.disable('p1', 'orders', true, 'u1', 'idem-disable');

    expect(result.enabled).toBe(false);
    expect(projects.update).toHaveBeenCalledWith(
      'p1',
      expect.objectContaining({
        cascade: true,
        moduleConfigs: expect.arrayContaining([
          expect.objectContaining({ moduleId: 'orders', enabled: false }),
        ]),
      }),
      'u1',
    );
  });
});
