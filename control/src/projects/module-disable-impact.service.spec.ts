import { Test, TestingModule } from '@nestjs/testing';
import { of } from 'rxjs';
import { ModuleDisableImpactService } from './module-disable-impact.service';
import { ProjectsService } from './projects.service';
import { ProvisioningModule } from '../provisioning/provisioning.module';

describe('ModuleDisableImpactService', () => {
  let service: ModuleDisableImpactService;
  const projects = {
    findOne: jest.fn(),
  };
  const pipeClient = { getService: jest.fn() };
  const ordersClient = { getService: jest.fn() };
  const automationClient = { getService: jest.fn() };

  beforeEach(async () => {
    jest.clearAllMocks();
    pipeClient.getService.mockReturnValue({
      listDeals: jest.fn().mockReturnValue(of({ total: 7 })),
    });
    ordersClient.getService.mockReturnValue({
      listOrders: jest.fn().mockReturnValue(of({ total: 3 })),
    });
    automationClient.getService.mockReturnValue({
      listRules: jest.fn().mockReturnValue(
        of({
          list: [{ id: 'r1', name: 'Напоминание' }],
        }),
      ),
    });
    projects.findOne.mockResolvedValue({
      effectiveModules: ['deals', 'orders', 'reports'],
      moduleConfigs: [
        { moduleId: 'deals', enabled: true, installed: true },
        { moduleId: 'orders', enabled: true, installed: true },
        { moduleId: 'reports', enabled: true, installed: true },
      ],
    });

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ModuleDisableImpactService,
        { provide: ProjectsService, useValue: projects },
        { provide: 'PIPE_GRPC', useValue: pipeClient },
        { provide: 'ORDERS_GRPC', useValue: ordersClient },
        { provide: 'AUTOMATION_GRPC', useValue: automationClient },
      ],
    }).compile();

    service = module.get(ModuleDisableImpactService);
    service.onModuleInit();
  });

  it('returns dependents and open-deal count for deals', async () => {
    const impact = await service.getImpact('p1', 'deals');
    expect(impact.dependentEnabledModules.map((m) => m.id)).toEqual(
      expect.arrayContaining(['orders']),
    );
    expect(impact.unfinishedRecords).toBe(7);
    expect(impact.stoppedAutomations).toEqual([]);
  });

  it('returns order total for orders module', async () => {
    const impact = await service.getImpact('p1', 'orders');
    expect(impact.unfinishedRecords).toBe(3);
  });

  it('lists enabled automation rules when disabling automation', async () => {
    projects.findOne.mockResolvedValue({
      effectiveModules: ['automation'],
      moduleConfigs: [{ moduleId: 'automation', enabled: true, installed: true }],
    });
    const impact = await service.getImpact('p1', 'automation');
    expect(impact.stoppedAutomations).toEqual([{ id: 'r1', name: 'Напоминание' }]);
    expect(impact.webhookDlqSuspended).toBe(true);
  });

  it('does not flag webhook/DLQ pause for non-automation modules', async () => {
    const impact = await service.getImpact('p1', 'deals');
    expect(impact.webhookDlqSuspended).toBe(false);
  });
});

describe('ModuleDisableImpactService Nest wiring', () => {
  it('resolves PIPE/ORDERS/AUTOMATION tokens via ProvisioningModule export', async () => {
    const module: TestingModule = await Test.createTestingModule({
      imports: [ProvisioningModule],
      providers: [
        ModuleDisableImpactService,
        { provide: ProjectsService, useValue: { findOne: jest.fn() } },
      ],
    }).compile();

    expect(module.get(ModuleDisableImpactService)).toBeDefined();
  });
});
