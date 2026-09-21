import { wireCreatedByRule } from './created-by-rule';
import type { ExecutorContext } from './executor.types';

describe('wireCreatedByRule (FR-AUTOM-120)', () => {
  const base: ExecutorContext = {
    projectId: 'p1',
    payload: {},
    ruleId: 'r1',
    ruleName: 'Правило A',
  };

  it('builds snake_case wire object with id and name', () => {
    expect(wireCreatedByRule(base)).toEqual({ rule_id: 'r1', name: 'Правило A' });
  });

  it('falls back name to rule id when title is empty', () => {
    expect(wireCreatedByRule({ ...base, ruleName: '' })).toEqual({
      rule_id: 'r1',
      name: 'r1',
    });
  });

  it('returns undefined without rule id', () => {
    expect(wireCreatedByRule({ ...base, ruleId: '' })).toBeUndefined();
  });
});
