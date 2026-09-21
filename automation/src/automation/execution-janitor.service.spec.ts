import { ExecutionJanitorService } from './execution-janitor.service';

describe('ExecutionJanitorService', () => {
  const enabledFlag = process.env.AUTOMATION_JANITOR_ENABLED;
  const intervalFlag = process.env.AUTOMATION_JANITOR_INTERVAL_MS;

  afterEach(() => {
    jest.useRealTimers();
    if (enabledFlag === undefined) delete process.env.AUTOMATION_JANITOR_ENABLED;
    else process.env.AUTOMATION_JANITOR_ENABLED = enabledFlag;
    if (intervalFlag === undefined) delete process.env.AUTOMATION_JANITOR_INTERVAL_MS;
    else process.env.AUTOMATION_JANITOR_INTERVAL_MS = intervalFlag;
  });

  it('does not schedule sweeps when disabled', () => {
    process.env.AUTOMATION_JANITOR_ENABLED = 'false';
    const automation = { reclaimStaleRunning: jest.fn() };
    const janitor = new ExecutionJanitorService(automation as never);
    janitor.onModuleInit();
    expect(automation.reclaimStaleRunning).not.toHaveBeenCalled();
    janitor.onModuleDestroy();
  });

  it('periodically reclaims stale running executions', async () => {
    jest.useFakeTimers();
    process.env.AUTOMATION_JANITOR_ENABLED = 'true';
    process.env.AUTOMATION_JANITOR_INTERVAL_MS = '1000';
    const automation = { reclaimStaleRunning: jest.fn(async () => undefined) };
    const janitor = new ExecutionJanitorService(automation as never);
    janitor.onModuleInit();
    await jest.advanceTimersByTimeAsync(1000);
    expect(automation.reclaimStaleRunning).toHaveBeenCalled();
    janitor.onModuleDestroy();
  });

  it('keeps sweeping after a failure', async () => {
    jest.useFakeTimers();
    process.env.AUTOMATION_JANITOR_ENABLED = 'true';
    process.env.AUTOMATION_JANITOR_INTERVAL_MS = '500';
    const automation = {
      reclaimStaleRunning: jest
        .fn()
        .mockRejectedValueOnce(new Error('mongo down'))
        .mockResolvedValue(undefined),
    };
    const janitor = new ExecutionJanitorService(automation as never);
    janitor.onModuleInit();
    await jest.advanceTimersByTimeAsync(500);
    await jest.advanceTimersByTimeAsync(500);
    expect(automation.reclaimStaleRunning).toHaveBeenCalledTimes(2);
    janitor.onModuleDestroy();
  });
});
