import { bumpRuleStats, parseRuleStats } from './rule-stats';

describe('rule-stats (FR-AUTOM-350)', () => {
  it('increments matched and executed counters', () => {
    const next = bumpRuleStats('{}', { matched: true, executed: true, at: 1000 });
    expect(parseRuleStats(next)).toMatchObject({
      matched30d: 1,
      executed30d: 1,
      last_execution_at: 1000,
    });
  });

  it('records lastError', () => {
    const next = bumpRuleStats('{}', { matched: true, executed: true, error: 'boom', at: 1 });
    expect(parseRuleStats(next).lastError).toBe('boom');
  });
});
