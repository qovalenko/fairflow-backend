/**
 * `google.protobuf.Struct` codec for control project module settings — gateway
 * copy of control/src/grpc/struct-codec.ts (workspaces don't share non-`shared`
 * sources; crm-bff and product keep local copies of their prefill codec the
 * same way, GAP-PRODUCTS-160).
 *
 * Wire shape (protobuf.js bundles the well-known descriptors already camelCase,
 * so `keepCase: true` does NOT apply): `{ fields: { key: { stringValue |
 * numberValue | boolValue | listValue | structValue | nullValue } } }`. A plain
 * JS map serialises to an EMPTY Struct — module settings were silently lost in
 * both directions until encoded/decoded explicitly. Proof:
 * control/src/grpc/module-settings-struct.spec.ts.
 */
export type JsonValue = string | number | boolean | null | JsonValue[] | JsonMap;
export type JsonMap = { [key: string]: JsonValue };

type WireValue = Record<string, unknown>;

function toWireValue(v: unknown): WireValue | undefined {
  if (v === null) return { nullValue: 0 };
  if (typeof v === 'string') return { stringValue: v };
  if (typeof v === 'number') return Number.isFinite(v) ? { numberValue: v } : undefined;
  if (typeof v === 'boolean') return { boolValue: v };
  if (Array.isArray(v)) {
    return {
      listValue: { values: v.map(toWireValue).filter((x): x is WireValue => x !== undefined) },
    };
  }
  if (typeof v === 'object') return { structValue: jsonToStruct(v) };
  return undefined;
}

/** Plain JSON map → wire (Struct). */
export function jsonToStruct(value: unknown): { fields: Record<string, WireValue> } {
  const fields: Record<string, WireValue> = {};
  if (value != null && typeof value === 'object' && !Array.isArray(value)) {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      const wire = toWireValue(v);
      if (wire !== undefined) fields[k] = wire;
    }
  }
  return { fields };
}

function fromWireValue(v: unknown): JsonValue | undefined {
  if (v === null || typeof v === 'string' || typeof v === 'boolean') return v;
  if (typeof v === 'number') return Number.isFinite(v) ? v : undefined;
  if (Array.isArray(v)) {
    return v.map(fromWireValue).filter((x): x is JsonValue => x !== undefined);
  }
  if (typeof v !== 'object' || v === undefined) return undefined;
  const w = v as Record<string, unknown>;
  if (typeof w.stringValue === 'string') return w.stringValue;
  if (typeof w.numberValue === 'number') return w.numberValue;
  if (typeof w.boolValue === 'boolean') return w.boolValue;
  if ('nullValue' in w) return null;
  if ('listValue' in w) {
    const values = (w.listValue as { values?: unknown[] } | undefined)?.values;
    return Array.isArray(values)
      ? values.map(fromWireValue).filter((x): x is JsonValue => x !== undefined)
      : [];
  }
  if ('structValue' in w) return structToJson(w.structValue);
  return structToJson(w);
}

/**
 * Wire (Struct) → plain JSON map. Tolerates an already-plain map from an older
 * peer (mixed-version rollout).
 */
export function structToJson(value: unknown): JsonMap {
  if (value == null || typeof value !== 'object' || Array.isArray(value)) return {};
  const fields = (value as { fields?: unknown }).fields;
  const src =
    fields != null && typeof fields === 'object' && !Array.isArray(fields)
      ? (fields as Record<string, unknown>)
      : (value as Record<string, unknown>);
  const out: JsonMap = {};
  for (const [k, v] of Object.entries(src)) {
    const decoded = fromWireValue(v);
    if (decoded !== undefined) out[k] = decoded;
  }
  return out;
}
