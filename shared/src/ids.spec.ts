import { newEntityId } from './ids';

/**
 * Unit test for the canonical entity id (UUIDv7, architecture-api-rules-v1).
 * UUIDv7 is time-ordered, so ids minted in sequence are lexicographically
 * non-decreasing — a property downstream sort/pagination relies on.
 */
describe('newEntityId', () => {
  it('produces a well-formed v7 UUID', () => {
    const id = newEntityId();
    expect(id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });

  it('is unique across a batch', () => {
    const ids = Array.from({ length: 1000 }, () => newEntityId());
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('is time-ordered (lexicographically non-decreasing)', () => {
    const a = newEntityId();
    const b = newEntityId();
    // v7 embeds a millisecond timestamp in the high bits → a <= b.
    expect(a <= b).toBe(true);
  });
});
