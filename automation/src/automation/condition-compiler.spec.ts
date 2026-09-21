/**
 * TODO-038 regression: the exact condition body the classic form sends must be
 * evaluatable by the domain compiler, and non-compilable trees must be
 * detectable at save time (validateConditionTree) instead of silently
 * evaluating to `false` forever.
 */
import { compileConditions, validateConditionTree } from './condition-compiler';

describe('compileConditions with the form payload shape', () => {
  it('evaluates the canonical {and:[...]} body the form now builds', () => {
    // Mirrors AutomationForm.buildPayload: «сумма > 1000» + «owner не пуст».
    const formBody = {
      and: [
        { field: 'amount', op: 'gt', value: '1000' },
        { field: 'owner', op: 'exists', value: true },
      ],
    };
    const predicate = compileConditions(JSON.stringify(formBody));
    expect(predicate({ amount: 2000, owner: 'u1' })).toBe(true);
    expect(predicate({ amount: 500, owner: 'u1' })).toBe(false);
    expect(predicate({ amount: 2000 })).toBe(false);
  });

  it('maps ne/is_empty via neq/exists like the form operator mapping does', () => {
    const predicate = compileConditions(
      JSON.stringify({
        and: [
          { field: 'status', op: 'neq', value: 'lost' },
          { field: 'deletedAt', op: 'exists', value: false },
        ],
      }),
    );
    expect(predicate({ status: 'won' })).toBe(true);
    expect(predicate({ status: 'lost' })).toBe(false);
    expect(predicate({ status: 'won', deletedAt: 123 })).toBe(false);
  });

  it('legacy {op:and,args} shape is fail-closed at runtime (never matches)', () => {
    const legacy = { op: 'and', args: [{ field: 'amount', op: 'gt', value: 0 }] };
    expect(compileConditions(JSON.stringify(legacy))({ amount: 10 })).toBe(false);
  });
});

describe('validateConditionTree (reject-on-save, FR-AUTOM-070)', () => {
  it('accepts empty / canonical trees', () => {
    expect(validateConditionTree('')).toBeNull();
    expect(validateConditionTree('[]')).toBeNull();
    expect(validateConditionTree('{}')).toBeNull();
    expect(
      validateConditionTree(
        JSON.stringify({ and: [{ field: 'a', op: 'eq', value: 1 }] }),
      ),
    ).toBeNull();
    expect(
      validateConditionTree(
        JSON.stringify({ not: { or: [[{ field: 'a', op: 'exists' }]] } }),
      ),
    ).toBeNull();
  });

  it('rejects the legacy {op:and,args} shape', () => {
    expect(
      validateConditionTree(
        JSON.stringify({ op: 'and', args: [{ field: 'a', op: 'eq', value: 1 }] }),
      ),
    ).toMatch(/unknown condition node shape/);
  });

  it('rejects unknown operators (ne / is_empty must be mapped by the form)', () => {
    expect(
      validateConditionTree(JSON.stringify({ and: [{ field: 'a', op: 'ne', value: 1 }] })),
    ).toMatch(/unknown operator "ne"/);
    expect(
      validateConditionTree(JSON.stringify([{ field: 'a', op: 'is_empty' }])),
    ).toMatch(/unknown operator "is_empty"/);
  });

  it('rejects malformed JSON and non-object nodes', () => {
    expect(validateConditionTree('{oops')).toMatch(/not valid JSON/);
    expect(validateConditionTree(JSON.stringify({ and: 'x' }))).toMatch(/must be an array/);
    expect(validateConditionTree(JSON.stringify([42]))).toMatch(/must be an object/);
  });
});
