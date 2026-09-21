import { ActivityExecutor } from './activity-executor';
import type { GrpcInvokeResult } from './grpc-action-executor';
import type { ExecutorContext } from './executor.types';

class TestExecutor extends ActivityExecutor {
  calls: Array<Record<string, unknown>> = [];
  result: GrpcInvokeResult = { ok: true, response: { id: 'a-1' } };

  protected async call(
    _method: string,
    req: unknown,
    _ctx: ExecutorContext,
  ): Promise<{ ok: boolean; error?: string }> {
    this.calls.push(req as Record<string, unknown>);
    return this.result.ok ? { ok: true } : { ok: false, error: 'fail' };
  }
}

const ctx = (extra: Partial<ExecutorContext> = {}): ExecutorContext => ({
  projectId: 'p1',
  userId: 'u1',
  payload: { deal_id: 'd1' },
  ruleId: 'rule-42',
  ruleName: 'Напомнить менеджеру',
  ...extra,
});

describe('ActivityExecutor created_by_rule (FR-AUTOM-120)', () => {
  it('passes created_by_rule to CreateActivity when rule context is present', async () => {
    const ex = new TestExecutor();
    await ex.execute('create_activity', { config: { title: 'Задача' } }, ctx());

    expect(ex.calls).toHaveLength(1);
    expect(ex.calls[0].created_by_rule).toEqual({
      rule_id: 'rule-42',
      name: 'Напомнить менеджеру',
    });
  });

  it('omits created_by_rule when dispatch has no rule id', async () => {
    const ex = new TestExecutor();
    await ex.execute(
      'create_activity',
      { config: { title: 'Задача' } },
      ctx({ ruleId: '', ruleName: '' }),
    );

    expect(ex.calls[0].created_by_rule).toBeUndefined();
  });

  it('falls back assignee to trigger owner then rule author (FR-AUTOM-110)', async () => {
    const ex = new TestExecutor();
    await ex.execute(
      'create_activity',
      { config: { title: 'Задача' } },
      ctx({
        payload: { owner_id: 'owner-1' },
        ruleAuthorId: 'author-9',
        userId: '',
      }),
    );
    expect(ex.calls[0].assignee_id).toBe('owner-1');
  });
});
