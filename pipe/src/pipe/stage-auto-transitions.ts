/**
 * FR-DEALS-220 / FR-MDEAL-22: pipeline auto-transition graph validation.
 * Rules are directed edges `fromStageId → toStageId`; cycles are rejected at save time.
 */

export type StageAutoTransition = {
  fromStageId: string;
  toStageId: string;
};

export type AutoTransitionValidationIssue =
  | { code: 'UNKNOWN_STAGE'; stageId: string }
  | { code: 'SAME_STAGE'; fromStageId: string }
  | { code: 'CYCLE'; path: string[] };

/** Normalize wire/mongo shapes into `{fromStageId,toStageId}`. */
export function normalizeAutoTransitions(raw: unknown): StageAutoTransition[] {
  if (!Array.isArray(raw)) return [];
  const out: StageAutoTransition[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const row = item as Record<string, unknown>;
    const fromStageId = String(row.fromStageId ?? row.from_stage_id ?? '').trim();
    const toStageId = String(row.toStageId ?? row.to_stage_id ?? '').trim();
    if (!fromStageId || !toStageId) continue;
    out.push({ fromStageId, toStageId });
  }
  return out;
}

/**
 * Validate auto-transition rules against pipeline stage ids (DFS cycle detection).
 * Returns the first blocking issue, or `null` when the graph is acyclic and valid.
 */
export function validateAutoTransitions(
  stageIds: Iterable<string>,
  transitions: StageAutoTransition[],
): AutoTransitionValidationIssue | null {
  const known = new Set(stageIds);
  const adj = new Map<string, string[]>();

  for (const t of transitions) {
    if (!known.has(t.fromStageId)) return { code: 'UNKNOWN_STAGE', stageId: t.fromStageId };
    if (!known.has(t.toStageId)) return { code: 'UNKNOWN_STAGE', stageId: t.toStageId };
    if (t.fromStageId === t.toStageId) return { code: 'SAME_STAGE', fromStageId: t.fromStageId };
    const list = adj.get(t.fromStageId) ?? [];
    list.push(t.toStageId);
    adj.set(t.fromStageId, list);
  }

  const visiting = new Set<string>();
  const visited = new Set<string>();
  const stack: string[] = [];

  const dfs = (node: string): AutoTransitionValidationIssue | null => {
    if (visited.has(node)) return null;
    if (visiting.has(node)) {
      const cycleStart = stack.indexOf(node);
      return { code: 'CYCLE', path: stack.slice(cycleStart).concat(node) };
    }
    visiting.add(node);
    stack.push(node);
    for (const next of adj.get(node) ?? []) {
      const issue = dfs(next);
      if (issue) return issue;
    }
    stack.pop();
    visiting.delete(node);
    visited.add(node);
    return null;
  };

  for (const id of known) {
    const issue = dfs(id);
    if (issue) return issue;
  }
  return null;
}

/** Lookup: first configured auto-target for a stage the deal just entered. */
export function resolveAutoTransitionTarget(
  transitions: StageAutoTransition[] | undefined,
  enteredStageId: string,
): string | null {
  if (!transitions?.length || !enteredStageId) return null;
  const hit = transitions.find((t) => t.fromStageId === enteredStageId);
  return hit?.toStageId ?? null;
}
