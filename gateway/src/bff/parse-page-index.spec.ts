import { parsePageIndex } from './parse-page-index';

describe('parsePageIndex (products list gate)', () => {
  it('clamps NaN and negative values to 0', () => {
    expect(parsePageIndex(undefined)).toBe(0);
    expect(parsePageIndex('')).toBe(0);
    expect(parsePageIndex('abc')).toBe(0);
    expect(parsePageIndex('-3')).toBe(0);
  });

  it('passes through valid non-negative integers', () => {
    expect(parsePageIndex('0')).toBe(0);
    expect(parsePageIndex('2')).toBe(2);
  });
});
