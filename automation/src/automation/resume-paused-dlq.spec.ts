import { AutomationService } from './automation.service';

describe('AutomationService.resumePausedDlq (FR-PLATFORM-115)', () => {
  const make = () => {
    const dlqRows: Array<Record<string, unknown>> = [
      { project_id: 'p1', id: 'd1', status: 'paused_module_disabled' },
      { project_id: 'p1', id: 'd2', status: 'failed' },
    ];
    const dlq = {
      updateMany: jest.fn(async (filter: Record<string, unknown>, update: Record<string, unknown>) => {
        let count = 0;
        for (const row of dlqRows) {
          if (row.project_id !== filter.project_id) continue;
          if (filter.status !== row.status) continue;
          Object.assign(row, update.$set);
          count++;
        }
        return { modifiedCount: count };
      }),
    };
    const mongo = {
      dlq: () => dlq,
      rules: () => ({ updateMany: jest.fn() }),
    };
    const service = Object.create(AutomationService.prototype) as AutomationService;
    Object.assign(service, {
      mongo,
      requireProjectId: (id: string) => id,
      emitFact: jest.fn(),
    });
    return { service, dlqRows, dlq };
  };

  it('discard dismisses paused_module_disabled rows', async () => {
    const { service, dlqRows } = make();
    const res = await service.resumePausedDlq('p1', 'discard');
    expect(res.processed).toBe(1);
    expect(dlqRows[0].status).toBe('dismissed');
    expect(dlqRows[1].status).toBe('failed');
  });

  it('deliver moves paused rows back to failed for retry', async () => {
    const { service, dlqRows } = make();
    const res = await service.resumePausedDlq('p1', 'deliver');
    expect(res.processed).toBe(1);
    expect(dlqRows[0].status).toBe('failed');
    expect(Number(dlqRows[0].next_retry_at)).toBeGreaterThan(0);
  });
});
