import { computeDerivedDealFields } from './pipe.service';

describe('computeDerivedDealFields (FR-DEALS-180)', () => {
  const DAY_MS = 86_400_000;

  it('marks stalled deals when days on stage exceed rotting threshold', () => {
    const now = Date.now();
    const doc = {
      stageEnteredAt: now - 10 * DAY_MS,
      stageId: 's1',
      stageLog: [],
    };
    const derived = computeDerivedDealFields(doc, 7);
    expect(derived.days_on_stage).toBeGreaterThanOrEqual(10);
    expect(derived.is_stalled).toBe(true);
    expect(derived.stage_return_count).toBe(0);
  });

  it('does not count the current open stageLog row as a return', () => {
    const now = Date.now();
    const doc = {
      stageEnteredAt: now - 2 * DAY_MS,
      stageId: 's1',
      stageLog: [{ stageId: 's1', enteredAt: now - 2 * DAY_MS }],
    };
    const derived = computeDerivedDealFields(doc, 0);
    expect(derived.stage_return_count).toBe(0);
    expect(derived.days_on_stage).toBeGreaterThanOrEqual(2);
  });

  it('counts stage returns from stageLog visits', () => {
    const now = Date.now();
    const doc = {
      stageEnteredAt: now - 2 * DAY_MS,
      stageId: 's1',
      stageLog: [{ stageId: 's1', enteredAt: now - 10 * DAY_MS, exitedAt: now - 5 * DAY_MS }],
    };
    const derived = computeDerivedDealFields(doc, 0);
    expect(derived.stage_return_count).toBe(1);
    expect(derived.total_time_on_stage_days).toBeGreaterThanOrEqual(5);
  });
});
