/**
 * GAP-PRODUCTS-160 — `google.protobuf.Struct` codec for `Product.prefill`.
 *
 * `product.proto` declares `prefill` as `google.protobuf.Struct`, but this domain
 * and the gateway both passed/expected a plain JS map. protobuf.js resolves the
 * well-known `struct.proto` from its own bundled (already camelCase) descriptors,
 * so the loader's `keepCase: true` does NOT apply to `Value`'s oneof: the wire
 * shape is `{ fields: { key: { stringValue | numberValue | boolValue } } }`.
 * A plain map serialised to ZERO bytes — prefill was silently lost in BOTH
 * directions (nothing written on create/update, `{}` returned on read).
 *
 * Only scalars cross this boundary; `ProductService.sanitizePrefill` rejects the
 * rest with INVALID_ARGUMENT, so richer Value kinds are intentionally unsupported.
 */
export type PrefillValue = string | number | boolean;
export type Prefill = Record<string, PrefillValue>;

/** Wire (Struct) → plain map. Tolerates an already-plain map from an older peer. */
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

/** Plain map → wire (Struct). */
export function prefillToStruct(value: unknown): {
  fields: Record<string, Record<string, unknown>>;
} {
  const fields: Record<string, Record<string, unknown>> = {};
  if (value != null && typeof value === 'object' && !Array.isArray(value)) {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (typeof v === 'string') fields[k] = { stringValue: v };
      else if (typeof v === 'number') fields[k] = { numberValue: v };
      else if (typeof v === 'boolean') fields[k] = { boolValue: v };
      // `null` is deliberately NOT encoded (X5): neither decoder — `prefillFromStruct`
      // above, nor the gateway's copy in `crm-bff.controller.ts` — understands
      // `nullValue`, so a `{k: null}` key encoded as `{nullValue: 0}` came back as a
      // MISSING key: an asymmetric round-trip that made the two copies of this codec
      // disagree. Dropping it on the way in makes both directions and both copies
      // agree: a null-valued key simply is not part of the prefill.
      // Non-scalars are dropped for the same reason (`sanitizePrefill` rejects them).
    }
  }
  return { fields };
}
