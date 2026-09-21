/**
 * Lazy migration for v1 rules saved before write-time normalization (FR-AUTOM-010).
 * Same transforms as `scripts/migrate-automation-rules.ts` — idempotent.
 */

type LegacyLeaf = { field?: unknown; op?: unknown; value?: unknown };

function parseJson(raw: unknown): unknown {
  if (typeof raw !== 'string' || !raw.trim()) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function migrateLeaf(leaf: LegacyLeaf): Record<string, unknown> | null {
  if (!leaf || typeof leaf !== 'object') return null;
  const field = String(leaf.field ?? '').trim();
  const op = String(leaf.op ?? '').trim();
  if (!field || !op) return null;
  switch (op) {
    case 'ne':
      return { field, op: 'neq', value: leaf.value };
    case 'is_empty':
      return { field, op: 'exists', value: false };
    case 'is_not_empty':
      return { field, op: 'exists', value: true };
    default:
      return { field, op, value: leaf.value };
  }
}

/** Convert legacy `{op:'and'|'or', args:[...]}` to canonical `{and|or:[...]}`. */
export function migrateConditionsJson(raw: unknown): string | null {
  const parsed = parseJson(raw);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const node = parsed as { op?: unknown; args?: unknown };
  if ((node.op !== 'and' && node.op !== 'or') || !Array.isArray(node.args)) return null;
  const leaves = (node.args as LegacyLeaf[])
    .map(migrateLeaf)
    .filter((l): l is Record<string, unknown> => !!l);
  return JSON.stringify({ [String(node.op)]: leaves });
}

export type LegacyRulePatch = {
  trigger_type?: string;
  trigger_config_json?: string;
  conditions_json?: string;
};

/**
 * Compute migration patch for a v1 rule document. Returns null when already canonical.
 */
export function legacyRulePatch(doc: {
  engine_version?: number;
  trigger_type?: string;
  trigger_config_json?: string;
  conditions_json?: string;
}): LegacyRulePatch | null {
  if ((doc.engine_version ?? 1) === 2) return null;
  const patch: LegacyRulePatch = {};

  const triggerType = String(doc.trigger_type ?? '').trim();
  if (triggerType && triggerType !== 'event') {
    const cfg = (parseJson(doc.trigger_config_json) as Record<string, unknown>) ?? {};
    if (!cfg.event_name) cfg.event_name = triggerType;
    patch.trigger_type = 'event';
    patch.trigger_config_json = JSON.stringify(cfg);
  }

  const migrated = migrateConditionsJson(doc.conditions_json);
  if (migrated != null) patch.conditions_json = migrated;

  return Object.keys(patch).length > 0 ? patch : null;
}
