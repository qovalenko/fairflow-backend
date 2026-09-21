/**
 * Module settings schema — real JSON Schema 2020-12 (subset) for module
 * `settingsSchema` + typed value validation (U4-BE / P2.d).
 *
 * Two concerns live here:
 *  1. A converter from the registry's ad-hoc *shorthand* (`module-registry.ts`,
 *     e.g. `{ defaultView: ['list','grid'] }`, `{ webhookUrl: 'string' }`) to a
 *     proper JSON Schema 2020-12 object schema. This lets the registry stay in
 *     the compact shorthand (minimal diff) while the manifest / validation layer
 *     always deals with a real `$schema`-tagged 2020-12 document.
 *  2. A compact, dependency-free validator of the *supported subset* of JSON
 *     Schema 2020-12 (the keywords the registry actually needs). It is NOT a
 *     general-purpose validator (no `ajv` — shared must stay dependency-light);
 *     it implements honest semantics for: `type` (object/string/number/integer/
 *     boolean/array), `enum`, `properties`, `required`, `additionalProperties`,
 *     `items`, and the range/length/size bounds (`minimum`/`maximum`,
 *     `minLength`/`maxLength`, `minItems`/`maxItems`).
 *
 * The validator both *validates* and *cleans* (coerces): with
 * `additionalProperties:false` unknown keys are reported AND stripped from the
 * returned `value`; a property whose value violates its schema is reported AND
 * dropped from `value`. Callers on a merge/defaults path can therefore ignore
 * `errors` and just take the (soft-cleaned) `value`; callers on a user save path
 * can reject when `!valid` and surface `errors`.
 */

import type { JsonValue } from './module-registry';

export const JSON_SCHEMA_2020_12 = 'https://json-schema.org/draft/2020-12/schema' as const;

/** JSON Schema types the subset validator understands. */
export type SupportedSchemaType =
  | 'object'
  | 'string'
  | 'number'
  | 'integer'
  | 'boolean'
  | 'array';

/**
 * Structural view over a JSON Schema node (subset). Kept as a plain
 * JSON-compatible shape so schemas remain `JsonValue` and can flow through the
 * manifest verbatim.
 */
export interface JsonSchemaNode {
  $schema?: string;
  type?: SupportedSchemaType;
  enum?: JsonValue[];
  const?: JsonValue;
  properties?: Record<string, JsonValue>;
  required?: string[];
  additionalProperties?: boolean;
  items?: JsonValue;
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
  minItems?: number;
  maxItems?: number;
}

/** Root object schema produced by {@link shorthandToJsonSchema}. */
export interface JsonSchemaObject extends JsonSchemaNode {
  $schema: string;
  type: 'object';
  properties: Record<string, JsonValue>;
  additionalProperties: false;
}

export interface SettingsValidationError {
  /** JSON-pointer-ish path to the offending value (`/`-rooted, e.g. `/defaultView`). */
  path: string;
  message: string;
}

export interface SettingsValidationResult {
  valid: boolean;
  /** Cleaned value: unknown keys stripped, type/enum-violating props dropped. */
  value: Record<string, JsonValue>;
  errors: SettingsValidationError[];
}

const TYPE_KEYWORDS: ReadonlySet<string> = new Set([
  'string',
  'number',
  'integer',
  'boolean',
  'array',
]);

function isPlainObject(v: unknown): v is Record<string, JsonValue> {
  return Boolean(v) && typeof v === 'object' && !Array.isArray(v);
}

/**
 * Convert a single registry *shorthand* field descriptor to a JSON Schema node.
 *
 * Recognised forms (the only ones the registry uses):
 *  - `'string' | 'number' | 'integer' | 'boolean' | 'array'` → `{ type }`
 *  - `['array']` (single-element sentinel)                    → `{ type:'array' }`
 *  - `['a','b',...]` (string list)                            → `{ type:'string', enum }`
 *  - an already-full schema object (`{type}`/`{enum}`)        → passed through
 *  - anything else                                            → `{}` (accept-any)
 */
export function shorthandFieldToSchema(shorthand: JsonValue): JsonSchemaNode {
  if (typeof shorthand === 'string') {
    if (TYPE_KEYWORDS.has(shorthand)) {
      return { type: shorthand as SupportedSchemaType };
    }
    // Unknown bare string: treat as a fixed literal (honest, non-lossy).
    return { const: shorthand };
  }
  if (Array.isArray(shorthand)) {
    // `['array']` is the registry sentinel for an array-typed field, NOT a
    // single-value enum. A genuine one-value enum is not used by the registry.
    if (shorthand.length === 1 && shorthand[0] === 'array') {
      return { type: 'array' };
    }
    const enumValues = shorthand.filter((v): v is string => typeof v === 'string');
    return { type: 'string', enum: enumValues };
  }
  if (isPlainObject(shorthand) && ('type' in shorthand || 'enum' in shorthand || 'const' in shorthand)) {
    // Already a (subset) JSON Schema — pass through unchanged.
    return shorthand as JsonSchemaNode;
  }
  return {};
}

/**
 * Convert a registry per-module shorthand map (`{ field: shorthand, ... }`) into
 * a real JSON Schema 2020-12 object schema. `additionalProperties:false` mirrors
 * the old whitelist semantics (only declared fields are accepted).
 */
export function shorthandToJsonSchema(
  shorthand: Record<string, JsonValue>,
): JsonSchemaObject {
  const properties: Record<string, JsonValue> = {};
  for (const [key, value] of Object.entries(shorthand)) {
    properties[key] = shorthandFieldToSchema(value) as unknown as JsonValue;
  }
  return {
    $schema: JSON_SCHEMA_2020_12,
    type: 'object',
    properties,
    additionalProperties: false,
  };
}

function typeMatches(value: JsonValue, type: SupportedSchemaType): boolean {
  switch (type) {
    case 'object':
      return isPlainObject(value);
    case 'array':
      return Array.isArray(value);
    case 'string':
      return typeof value === 'string';
    case 'boolean':
      return typeof value === 'boolean';
    case 'number':
      return typeof value === 'number' && Number.isFinite(value);
    case 'integer':
      return typeof value === 'number' && Number.isInteger(value);
    default:
      return false;
  }
}

function jsonEquals(a: JsonValue, b: JsonValue): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((v, i) => jsonEquals(v, b[i]));
  }
  if (isPlainObject(a) && isPlainObject(b)) {
    const ka = Object.keys(a);
    const kb = Object.keys(b);
    return ka.length === kb.length && ka.every((k) => k in b && jsonEquals(a[k], b[k]));
  }
  return false;
}

/**
 * Validate a single value against a subset schema node. Returns a cleaned value
 * when the node is an object (unknown keys stripped / bad props dropped),
 * otherwise the value verbatim. Errors are appended to `errors` with `path`.
 */
function validateNode(
  value: JsonValue,
  schema: JsonSchemaNode,
  path: string,
  errors: SettingsValidationError[],
): { ok: boolean; value: JsonValue } {
  // const
  if ('const' in schema && schema.const !== undefined) {
    if (!jsonEquals(value, schema.const)) {
      errors.push({ path, message: `must equal ${JSON.stringify(schema.const)}` });
      return { ok: false, value };
    }
  }

  // enum
  if (Array.isArray(schema.enum)) {
    if (!schema.enum.some((e) => jsonEquals(value, e))) {
      errors.push({ path, message: `must be one of ${JSON.stringify(schema.enum)}` });
      return { ok: false, value };
    }
  }

  // type
  if (schema.type) {
    if (!typeMatches(value, schema.type)) {
      errors.push({ path, message: `must be of type ${schema.type}` });
      return { ok: false, value };
    }
  }

  // string bounds
  if (typeof value === 'string') {
    if (typeof schema.minLength === 'number' && value.length < schema.minLength) {
      errors.push({ path, message: `must be at least ${schema.minLength} chars` });
      return { ok: false, value };
    }
    if (typeof schema.maxLength === 'number' && value.length > schema.maxLength) {
      errors.push({ path, message: `must be at most ${schema.maxLength} chars` });
      return { ok: false, value };
    }
  }

  // numeric bounds
  if (typeof value === 'number') {
    if (typeof schema.minimum === 'number' && value < schema.minimum) {
      errors.push({ path, message: `must be >= ${schema.minimum}` });
      return { ok: false, value };
    }
    if (typeof schema.maximum === 'number' && value > schema.maximum) {
      errors.push({ path, message: `must be <= ${schema.maximum}` });
      return { ok: false, value };
    }
  }

  // array items + size
  if (Array.isArray(value)) {
    if (typeof schema.minItems === 'number' && value.length < schema.minItems) {
      errors.push({ path, message: `must have at least ${schema.minItems} items` });
      return { ok: false, value };
    }
    if (typeof schema.maxItems === 'number' && value.length > schema.maxItems) {
      errors.push({ path, message: `must have at most ${schema.maxItems} items` });
      return { ok: false, value };
    }
    if (isPlainObject(schema.items)) {
      const itemSchema = schema.items as JsonSchemaNode;
      // An items violation invalidates the whole array (no partial arrays).
      for (let i = 0; i < value.length; i++) {
        const res = validateNode(value[i], itemSchema, `${path}/${i}`, errors);
        if (!res.ok) return { ok: false, value };
      }
    }
  }

  // nested object
  if (schema.type === 'object' && isPlainObject(value)) {
    const cleaned = validateObject(value, schema, path, errors);
    return { ok: cleaned.ok, value: cleaned.value };
  }

  return { ok: true, value };
}

function validateObject(
  value: Record<string, JsonValue>,
  schema: JsonSchemaNode,
  path: string,
  errors: SettingsValidationError[],
): { ok: boolean; value: Record<string, JsonValue> } {
  const properties = isPlainObject(schema.properties) ? schema.properties : {};
  const additionalAllowed = schema.additionalProperties !== false;
  const out: Record<string, JsonValue> = {};
  let ok = true;

  for (const [key, raw] of Object.entries(value)) {
    const propSchema = properties[key];
    if (propSchema === undefined) {
      if (additionalAllowed) {
        out[key] = raw;
      } else {
        errors.push({ path: `${path}/${key}`, message: 'unknown property' });
        ok = false;
      }
      continue;
    }
    const res = validateNode(raw, propSchema as JsonSchemaNode, `${path}/${key}`, errors);
    if (res.ok) {
      out[key] = res.value;
    } else {
      ok = false; // bad prop dropped from `out`
    }
  }

  for (const req of schema.required ?? []) {
    if (!(req in out)) {
      errors.push({ path: `${path}/${req}`, message: 'is required' });
      ok = false;
    }
  }

  return { ok, value: out };
}

/**
 * Validate + clean a settings object against a JSON Schema 2020-12 (subset)
 * object schema. Accepts either a full `$schema`-tagged object schema (from
 * {@link shorthandToJsonSchema}) or a bare shorthand map — a shorthand is
 * detected and converted transparently for convenience.
 */
export function validateSettings(
  raw: unknown,
  schema: Record<string, JsonValue> | JsonSchemaObject | JsonSchemaNode,
): SettingsValidationResult {
  const objectSchema: JsonSchemaNode = isJsonSchemaObject(schema)
    ? (schema as JsonSchemaNode)
    : shorthandToJsonSchema(schema as Record<string, JsonValue>);

  const errors: SettingsValidationError[] = [];
  const input = isPlainObject(raw) ? (raw as Record<string, JsonValue>) : {};
  if (!isPlainObject(raw) && raw !== undefined && raw !== null) {
    errors.push({ path: '', message: 'settings must be an object' });
    return { valid: false, value: {}, errors };
  }
  const { ok, value } = validateObject(input, objectSchema, '', errors);
  return { valid: ok, value, errors };
}

/** Heuristic: an already-materialised object schema vs. a shorthand map. */
function isJsonSchemaObject(v: unknown): v is JsonSchemaObject | JsonSchemaNode {
  return (
    isPlainObject(v) &&
    (v as Record<string, unknown>).type === 'object' &&
    ('properties' in v || 'additionalProperties' in v || '$schema' in v)
  );
}
