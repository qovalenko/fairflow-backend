import { Injectable } from '@nestjs/common';
import { MongoService } from '../mongo/mongo.service';

/**
 * Per-rule anti-avalanche throttle (FR-AUTOM-160 / FR-MAUT-11).
 * Counts recent executions in a sliding window; excess deliveries get
 * `status:throttled` without running actions.
 */
@Injectable()
export class RuleThrottleService {
  private readonly limit =
    Number(process.env.AUTOMATION_RULE_RATE_LIMIT ?? 10) || 10;
  private readonly windowMs =
    Number(process.env.AUTOMATION_RULE_RATE_WINDOW_MS ?? 60_000) || 60_000;

  constructor(private readonly mongo: MongoService) {}

  /** True when the rule has already hit the rate limit in the current window. */
  async isThrottled(projectId: string, ruleId: string, now = Date.now()): Promise<boolean> {
    if (this.limit <= 0) return false;
    const since = now - this.windowMs;
    const count = await this.mongo.executions().countDocuments({
      project_id: projectId,
      rule_id: ruleId,
      created_at: { $gte: since },
      status: { $nin: ['throttled'] },
    });
    return count >= this.limit;
  }
}
