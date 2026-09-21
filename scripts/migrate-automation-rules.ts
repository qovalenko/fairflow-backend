/**
 * One-off data migration for existing v1 automation rules (TODO-037 / TODO-038).
 *
 * Rules saved BEFORE the write-time normalization landed are unmatchable /
 * unevaluable:
 *  - trigger: the classic form stored the catalog id ('crm.deal.created', …)
 *    verbatim in `trigger_type`, but the bus consumer only selects
 *    `trigger_type='event'` and matches `trigger_config_json.event_name`;
 *  - conditions: the form stored `{op:'and', args:[{field,op,value}]}` with
 *    `ne`/`is_empty`/`is_not_empty` operators — a shape/ops set the
 *    condition-compiler evaluates to `false` (fail-closed), so every execution
 *    was skipped with `conditions_not_met`.
 *
 * This script rewrites both to the canonical shapes the domain now enforces on
 * save (see automation.service.ts normalizeV1Trigger / assertConditionsCompilable):
 *  - trigger_type='event' + trigger_config_json {"event_name": "<catalog id>"};
 *  - conditions_json {"and":[{field, op, value}, …]} with ne→neq,
 *    is_empty→exists:false, is_not_empty→exists:true.
 *
 * Idempotent; v2 (engine_version=2) rules are never touched. DRY-RUN by default —
 * pass --apply to write:
 *
 *   npx ts-node --compiler-options '{"module":"CommonJS"}' scripts/migrate-automation-rules.ts          # report only
 *   npx ts-node --compiler-options '{"module":"CommonJS"}' scripts/migrate-automation-rules.ts --apply  # write
 */
import * as path from 'node:path';
import { config as loadEnv } from 'dotenv';
import { MongoClient } from 'mongodb';

const servicesRoot = path.resolve(__dirname, '..');
loadEnv({ path: path.join(servicesRoot, '.fairflow-dev.env') });
loadEnv({ path: path.join(servicesRoot, '.env') });

const MONGODB_URI = process.env.MONGODB_URI?.trim();
const APPLY = process.argv.includes('--apply');

type LegacyLeaf = { field?: unknown; op?: unknown; value?: unknown };

function parseJson(raw: unknown): unknown {
  if (typeof raw !== 'string' || !raw.trim()) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/** Map a legacy form leaf to the condition-compiler grammar; null = not a leaf. */
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

/**
 * Convert a legacy `{op:'and'|'or', args:[...]}` tree (или лист со старым
 * оператором) to the canonical `{and:[...]}` / `{or:[...]}` shape.
 * Returns null when the stored value is already canonical / empty.
 */
function migrateConditions(raw: unknown): string | null {
  const parsed = parseJson(raw);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const node = parsed as { op?: unknown; args?: unknown };
  if ((node.op !== 'and' && node.op !== 'or') || !Array.isArray(node.args)) return null;
  const leaves = (node.args as LegacyLeaf[]).map(migrateLeaf).filter((l): l is Record<string, unknown> => !!l);
  return JSON.stringify({ [String(node.op)]: leaves });
}

async function main(): Promise<void> {
  if (!MONGODB_URI) {
    console.error('MONGODB_URI is required (set it in .env / .fairflow-dev.env).');
    process.exit(1);
  }
  const client = new MongoClient(MONGODB_URI);
  await client.connect();
  const rules = client.db().collection('automation_rules');

  let triggerFixed = 0;
  let conditionsFixed = 0;
  let scanned = 0;

  // Only v1 rules; v2 stores denormalized trigger fields derived from the graph.
  const cursor = rules.find({ $or: [{ engine_version: { $exists: false } }, { engine_version: { $ne: 2 } }] });
  for await (const doc of cursor) {
    scanned += 1;
    const set: Record<string, unknown> = {};

    // TODO-037: catalog trigger id stored verbatim in trigger_type.
    const triggerType = String(doc.trigger_type ?? '');
    if (triggerType && triggerType !== 'event') {
      const cfg = (parseJson(doc.trigger_config_json) as Record<string, unknown>) ?? {};
      if (!cfg.event_name) cfg.event_name = triggerType;
      set.trigger_type = 'event';
      set.trigger_config_json = JSON.stringify(cfg);
      triggerFixed += 1;
    }

    // TODO-038: legacy {op:'and',args:[...]} condition tree.
    const migrated = migrateConditions(doc.conditions_json);
    if (migrated != null) {
      set.conditions_json = migrated;
      conditionsFixed += 1;
    }

    if (Object.keys(set).length > 0) {
      const label = `${doc.project_id}/${doc.id} "${doc.name ?? ''}"`;
      if (APPLY) {
        set.updated_at = Date.now();
        await rules.updateOne({ _id: doc._id }, { $set: set });
        console.log(`migrated ${label}: ${Object.keys(set).join(', ')}`);
      } else {
        console.log(`[dry-run] would migrate ${label}: ${Object.keys(set).join(', ')}`);
      }
    }
  }

  console.log(
    `${APPLY ? 'Applied' : 'Dry-run'}: scanned=${scanned}, trigger_fixed=${triggerFixed}, conditions_fixed=${conditionsFixed}`,
  );
  await client.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
