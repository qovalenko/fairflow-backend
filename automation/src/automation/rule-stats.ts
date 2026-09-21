/**
 * Incremental stats_json maintenance (FR-AUTOM-350 / TODO-127).
 */

export type RuleStats = {
  matched30d: number;
  executed30d: number;
  lastError: string;
  last_execution_at?: number;
};

export function parseRuleStats(raw: string | undefined): RuleStats {
  try {
    const parsed = JSON.parse(raw || '{}') as Partial<RuleStats>;
    return {
      matched30d: Number(parsed.matched30d ?? 0) || 0,
      executed30d: Number(parsed.executed30d ?? 0) || 0,
      lastError: String(parsed.lastError ?? ''),
      last_execution_at: parsed.last_execution_at,
    };
  } catch {
    return { matched30d: 0, executed30d: 0, lastError: '' };
  }
}

export function bumpRuleStats(
  raw: string | undefined,
  update: {
    matched?: boolean;
    executed?: boolean;
    error?: string;
    at?: number;
  },
): string {
  const stats = parseRuleStats(raw);
  const at = update.at ?? Date.now();
  if (update.matched) stats.matched30d += 1;
  if (update.executed) stats.executed30d += 1;
  if (update.error) stats.lastError = update.error.slice(0, 500);
  stats.last_execution_at = at;
  return JSON.stringify(stats);
}
