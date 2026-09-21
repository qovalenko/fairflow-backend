import {
  normalizeAutoTransitions,
  resolveAutoTransitionTarget,
  validateAutoTransitions,
} from './stage-auto-transitions';

describe('stage-auto-transitions (FR-DEALS-220)', () => {
  const stages = ['a', 'b', 'c'];

  it('normalizeAutoTransitions accepts snake_case wire fields', () => {
    expect(normalizeAutoTransitions([{ from_stage_id: 'a', to_stage_id: 'b' }])).toEqual([
      { fromStageId: 'a', toStageId: 'b' },
    ]);
  });

  it('rejects unknown stage ids', () => {
    expect(validateAutoTransitions(stages, [{ fromStageId: 'a', toStageId: 'z' }])).toEqual({
      code: 'UNKNOWN_STAGE',
      stageId: 'z',
    });
  });

  it('rejects self-loops', () => {
    expect(validateAutoTransitions(stages, [{ fromStageId: 'a', toStageId: 'a' }])).toEqual({
      code: 'SAME_STAGE',
      fromStageId: 'a',
    });
  });

  it('rejects A→B→A cycles with DFS', () => {
    const issue = validateAutoTransitions(stages, [
      { fromStageId: 'a', toStageId: 'b' },
      { fromStageId: 'b', toStageId: 'a' },
    ]);
    expect(issue?.code).toBe('CYCLE');
  });

  it('accepts an acyclic chain', () => {
    expect(
      validateAutoTransitions(stages, [
        { fromStageId: 'a', toStageId: 'b' },
        { fromStageId: 'b', toStageId: 'c' },
      ]),
    ).toBeNull();
  });

  it('resolveAutoTransitionTarget returns the configured target', () => {
    const rules = [{ fromStageId: 'a', toStageId: 'b' }];
    expect(resolveAutoTransitionTarget(rules, 'a')).toBe('b');
    expect(resolveAutoTransitionTarget(rules, 'c')).toBeNull();
  });
});
