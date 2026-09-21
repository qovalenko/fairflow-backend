/** Struct codec for control `integration_settings` (same wire shape as product prefill). */
export type PrefillValue = string | number | boolean;
export type Prefill = Record<string, PrefillValue>;

export function prefillFromStruct(value: unknown): Prefill | undefined {
  if (value == null || typeof value !== 'object') return undefined;
  const fields = (value as { fields?: unknown }).fields;
  const src = (fields ?? value) as Record<string, unknown>;
  const out: Prefill = {};
  for (const [k, v] of Object.entries(src)) {
    if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') {
      out[k] = v;
      continue;
    }
    if (v == null || typeof v !== 'object') continue;
    const w = v as Record<string, unknown>;
    if (typeof w.stringValue === 'string') out[k] = w.stringValue;
    else if (typeof w.numberValue === 'number') out[k] = w.numberValue;
    else if (typeof w.boolValue === 'boolean') out[k] = w.boolValue;
  }
  return out;
}
