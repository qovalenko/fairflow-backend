/**
 * `google.protobuf.Struct` codec for project module settings (fable-review fix,
 * 5th recurrence of the GAP-PRODUCTS-160 loader landmine — see
 * product/src/product/prefill-struct.ts for the 1st).
 *
 * control.proto declares `personal_settings` / `integration_settings` /
 * `condition` as `google.protobuf.Struct`, but this domain and the gateway both
 * passed/expected plain JS maps. protobuf.js resolves the well-known
 * `struct.proto` from its own bundled (already camelCase) descriptors, so the
 * loader's `keepCase: true` does NOT apply to `Value`'s oneof: the wire shape is
 * `{ fields: { key: { stringValue | numberValue | boolValue | listValue |
 * structValue | nullValue } } }`. A plain map serialises to an EMPTY Struct —
 * settings were silently lost in BOTH directions (PUT stored `{}`, GET returned
 * `{}`), invisible to every mock-based unit test.
 *
 * Unlike prefill (scalars only), module settings carry nested arrays
 * (`indexableTypes: ['contact', …]`), so this codec is recursive over the full
 * Value kind set. Non-representable values (undefined, functions, NaN/Infinity)
 * are dropped, mirroring JSON semantics.
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
  // Tolerated plain forms (older peer / same-process caller).
  if (v === null || typeof v === 'string' || typeof v === 'boolean') return v;
  if (typeof v === 'number') return Number.isFinite(v) ? v : undefined;
  if (Array.isArray(v)) {
    return v.map(fromWireValue).filter((x): x is JsonValue => x !== undefined);
  }
  if (typeof v !== 'object' || v === undefined) return undefined;
  const w = v as Record<string, unknown>;
  // Wire Value oneof. `nullValue` may decode as 0 or 'NULL_VALUE' depending on
  // the peer's `enums` loader option — accept both.
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
  // Plain nested object (tolerated form).
  return structToJson(w);
}

/**
 * Wire (Struct) → plain JSON map. Tolerates an already-plain map from an older
 * peer: a top-level object without a decodable `fields` wrapper is walked as-is
 * (a plain map that itself contains a literal `fields` object key would be
 * misread as wire format — no current settings/condition payload does).
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
