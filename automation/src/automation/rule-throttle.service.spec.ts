import { RuleThrottleService } from './rule-throttle.service';

describe('RuleThrottleService (FR-AUTOM-160)', () => {
  it('returns true when count in window exceeds limit', async () => {
    const mongo = {
      executions: () => ({
        countDocuments: jest.fn(async () => 10),
      }),
    };
    const svc = new RuleThrottleService(mongo as never);
    await expect(svc.isThrottled('p1', 'r1')).resolves.toBe(true);
  });
});
