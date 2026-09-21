import type { ExecutorContext } from './executor.types';

/** Wire shape for `created_by_rule` on domain gRPC calls (proto snake_case). */
export type CreatedByRuleWire = { rule_id: string; name: string };

/**
 * Build the automation provenance marker FR-MAUT-36 expects on domain mutations.
 * Absent when the dispatch has no rule id (order final-action saga).
 */
export function wireCreatedByRule(ctx: ExecutorContext): CreatedByRuleWire | undefined {
  const ruleId = String(ctx.ruleId ?? '').trim();
  if (!ruleId) return undefined;
  const name = String(ctx.ruleName ?? '').trim();
  return { rule_id: ruleId, name: name || ruleId };
}
