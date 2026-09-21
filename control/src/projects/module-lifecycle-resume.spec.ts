import { ModuleLifecycleService } from './module-lifecycle.service';
import { ProjectsService } from './projects.service';
import { MutationIdempotencyService } from '../idempotency/mutation-idempotency.service';
import { AutomationLifecycleService } from '../provisioning/automation-lifecycle.service';

describe('ModuleLifecycleService.resumeDelivery (FR-PLATFORM-115)', () => {
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
          moduleId: 'contacts',
          enabled: true,
          runtimeStatus: 'suspended',
          everSuspended: true,
          configState: 'ready',
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

  it('activates runtime and calls automation DLQ resume for automation module', async () => {
    (projects.findOne as jest.Mock).mockResolvedValue({
      moduleConfigs: [
        {
          moduleId: 'automation',
          enabled: true,
          runtimeStatus: 'suspended',
          everSuspended: true,
          configState: 'ready',
          personalSettings: {},
          integrationSettings: { defaultWebhookSecret: 'x' },
          integrationMethodsEnabled: [],
        },
      ],
    });

    const result = await service.resumeDelivery('p1', 'automation', 'discard', 'u1', 'idem-1');

    expect(result.runtimeStatus).toBe('active');
    expect(projects.update).toHaveBeenCalledWith(
      'p1',
      expect.objectContaining({
        runtimeResume: { moduleId: 'automation', dlq: 'discard' },
      }),
      'u1',
    );
    expect(automationLifecycle.unfreezeRules).toHaveBeenCalledWith('p1', 'module_enabled');
    expect(automationLifecycle.resumePausedDlq).toHaveBeenCalledWith('p1', 'discard');
  });
});
