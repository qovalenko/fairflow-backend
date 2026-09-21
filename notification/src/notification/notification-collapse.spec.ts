import { buildCollapseKey, collapseWindowBucket } from './notification-collapse';

describe('notification-collapse', () => {
  it('groups events in the same window bucket', () => {
    const w = 300;
    const t = 1_700_000_000_000;
    const a = buildCollapseKey({
      user_id: 'u1',
      category: 'data',
      entity_type: 'contact',
      entity_id: 'c1',
      windowSec: w,
      nowMs: t,
    });
    const b = buildCollapseKey({
      user_id: 'u1',
      category: 'data',
      entity_type: 'contact',
      entity_id: 'c1',
      windowSec: w,
      nowMs: t + 60_000,
    });
    expect(a).toBe(b);
    const nextBucket = collapseWindowBucket(t + w * 1000, w);
    const c = buildCollapseKey({
      user_id: 'u1',
      category: 'data',
      entity_type: 'contact',
      entity_id: 'c1',
      windowSec: w,
      nowMs: nextBucket * w * 1000 + 1,
    });
    expect(c).not.toBe(a);
  });
});
