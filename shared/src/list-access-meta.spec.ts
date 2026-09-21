import { computeHiddenByPolicy } from './list-access-meta';

describe('computeHiddenByPolicy (FR-ACCESS-560)', () => {
  it('returns difference when project total exceeds visible', () => {
    expect(computeHiddenByPolicy(5, 20)).toBe(15);
  });

  it('never returns negative', () => {
    expect(computeHiddenByPolicy(20, 5)).toBe(0);
  });
});
