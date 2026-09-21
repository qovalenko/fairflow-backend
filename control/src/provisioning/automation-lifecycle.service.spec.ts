import { Logger } from '@nestjs/common';
import { of, throwError } from 'rxjs';
import { readRuntimeStatus } from '@fairflow/shared';
import { AutomationLifecycleService } from './automation-lifecycle.service';

jest.mock('@fairflow/shared', () => {
  const actual = jest.requireActual('@fairflow/shared');
  return {
    ...actual,
    readRuntimeStatus: jest.fn(),
  };
});

const readRuntimeStatusMock = readRuntimeStatus as jest.Mock;

describe('AutomationLifecycleService', () => {
  type Grpc = {
    freezeRules: jest.Mock;
    unfreezeRules: jest.Mock;
    reconcileRuleDependencies: jest.Mock;
    disableRulesForInactiveActor: jest.Mock;
    resumePausedDlq: jest.Mock;
  };

  let grpc: Grpc;
  let service: AutomationLifecycleService;
  let errorSpy: jest.SpyInstance;

  beforeEach(() => {
    readRuntimeStatusMock.mockReturnValue('active');
    grpc = {
      freezeRules: jest.fn().mockReturnValue(of({ frozen_rules: 1 })),
      unfreezeRules: jest.fn().mockReturnValue(of({ unfrozen_rules: 1 })),
      reconcileRuleDependencies: jest.fn().mockReturnValue(of({ updated_rules: 0 })),
      disableRulesForInactiveActor: jest.fn().mockReturnValue(of({ disabled_rules: 1 })),
      resumePausedDlq: jest.fn().mockReturnValue(of({ processed: 2 })),
    };
    service = new AutomationLifecycleService({ getService: () => grpc } as never);
    service.onModuleInit();
    errorSpy = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    errorSpy.mockRestore();
  });

  it('freezes rules when automation module is disabled', async () => {
    await service.syncModuleTransitions(
      'proj-1',
      [{ routingKey: 'control.module.disabled', moduleId: 'automation' }],
      [],
    );
    expect(grpc.freezeRules).toHaveBeenCalledWith(
      { project_id: 'proj-1', reason: 'module_disabled' },
      expect.anything(),
    );
  });

  it('unfreezes rules when automation module is enabled and runtime is active', async () => {
    await service.syncModuleTransitions(
      'proj-1',
      [{ routingKey: 'control.module.enabled', moduleId: 'automation' }],
      [{ moduleId: 'automation', enabled: true } as never],
    );
    expect(grpc.unfreezeRules).toHaveBeenCalledWith(
      { project_id: 'proj-1', reason: 'module_enabled' },
      expect.anything(),
    );
  });

  it('does not unfreeze on module enable when runtime is suspended', async () => {
    readRuntimeStatusMock.mockReturnValue('suspended');
    await service.syncModuleTransitions(
      'proj-1',
      [{ routingKey: 'control.module.enabled', moduleId: 'automation' }],
      [{ moduleId: 'automation', enabled: true } as never],
    );
    expect(grpc.unfreezeRules).not.toHaveBeenCalled();
  });

  it('unfreezes on runtime_resumed even after suspend', async () => {
    await service.syncModuleTransitions(
      'proj-1',
      [{ routingKey: 'control.module.runtime_resumed', moduleId: 'automation' }],
      [],
    );
    expect(grpc.unfreezeRules).toHaveBeenCalledWith(
      { project_id: 'proj-1', reason: 'module_enabled' },
      expect.anything(),
    );
  });

  it('reconciles rule dependencies when enabled modules are supplied', async () => {
    await service.syncModuleTransitions('proj-1', [], [], ['deals', 'automation']);
    expect(grpc.reconcileRuleDependencies).toHaveBeenCalledWith(
      { project_id: 'proj-1', enabled_modules: ['deals', 'automation'] },
      expect.anything(),
    );
  });

  it('syncArchiveTransition freezes on archive and unfreezes on unarchive', async () => {
    await service.syncArchiveTransition('proj-1', false, true);
    expect(grpc.freezeRules).toHaveBeenCalledWith(
      { project_id: 'proj-1', reason: 'project_archived' },
      expect.anything(),
    );

    grpc.freezeRules.mockClear();
    await service.syncArchiveTransition('proj-1', true, false);
    expect(grpc.unfreezeRules).toHaveBeenCalledWith(
      { project_id: 'proj-1', reason: 'project_unarchived' },
      expect.anything(),
    );
  });

  it('swallows automation transport errors without throwing', async () => {
    grpc.freezeRules.mockReturnValue(throwError(() => new Error('automation down')));
    await expect(service.freezeRules('proj-1', 'module_disabled')).resolves.toBeUndefined();
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('freezeRules'));
  });

  it('resumePausedDlq forwards the dlq fate to automation', async () => {
    await service.resumePausedDlq('proj-1', 'deliver');
    expect(grpc.resumePausedDlq).toHaveBeenCalledWith(
      { project_id: 'proj-1', dlq_fate: 'deliver' },
      expect.anything(),
    );
  });
});
