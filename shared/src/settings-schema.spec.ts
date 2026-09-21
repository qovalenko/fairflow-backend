/**
 * Unit tests for the settings-schema converter + subset validator (U4-BE / P2.d).
 *
 * Runs under the workspace jest config (shared/package.json, added with the
 * ops-http-contract tests) with `node:assert` for assertions — no new npm deps.
 */
import assert from 'node:assert/strict';

const test = it;

import {
  shorthandFieldToSchema,
  shorthandToJsonSchema,
  validateSettings,
  JSON_SCHEMA_2020_12,
} from './settings-schema';
import { MODULE_REGISTRY, normalizeModuleConfigs } from './module-registry';

// ── converter: shorthand → JSON Schema 2020-12 ──────────────────────────────
test('shorthandFieldToSchema: type keywords', () => {
  assert.deepEqual(shorthandFieldToSchema('string'), { type: 'string' });
  assert.deepEqual(shorthandFieldToSchema('number'), { type: 'number' });
  assert.deepEqual(shorthandFieldToSchema('boolean'), { type: 'boolean' });
});

test('shorthandFieldToSchema: enum vs array sentinel', () => {
  assert.deepEqual(shorthandFieldToSchema(['list', 'grid']), {
    type: 'string',
    enum: ['list', 'grid'],
  });
  assert.deepEqual(shorthandFieldToSchema(['array']), { type: 'array' });
});

test('shorthandFieldToSchema: passthrough for already-full schema', () => {
  const full = { type: 'integer', minimum: 1, maximum: 10 };
  assert.deepEqual(shorthandFieldToSchema(full), full);
});

test('shorthandToJsonSchema: builds a 2020-12 object schema', () => {
  const schema = shorthandToJsonSchema({ defaultView: ['list', 'grid'], webhookUrl: 'string' });
  assert.equal(schema.$schema, JSON_SCHEMA_2020_12);
  assert.equal(schema.type, 'object');
  assert.equal(schema.additionalProperties, false);
  assert.deepEqual(schema.properties, {
    defaultView: { type: 'string', enum: ['list', 'grid'] },
    webhookUrl: { type: 'string' },
  });
});

// ── validator: valid / invalid / unknown key / enum miss ────────────────────
test('validateSettings: accepts a valid enum value', () => {
  const res = validateSettings({ defaultView: 'grid' }, { defaultView: ['list', 'grid'] });
  assert.equal(res.valid, true);
  assert.deepEqual(res.value, { defaultView: 'grid' });
  assert.equal(res.errors.length, 0);
});

test('validateSettings: enum miss is dropped + reported', () => {
  const res = validateSettings({ defaultView: 'tiles' }, { defaultView: ['list', 'grid'] });
  assert.equal(res.valid, false);
  assert.deepEqual(res.value, {});
  assert.equal(res.errors.length, 1);
  assert.equal(res.errors[0].path, '/defaultView');
});

test('validateSettings: wrong type is dropped + reported', () => {
  const res = validateSettings({ syncIntervalMinutes: 'soon' }, { syncIntervalMinutes: 'number' });
  assert.equal(res.valid, false);
  assert.deepEqual(res.value, {});
  assert.match(res.errors[0].message, /type number/);
});

test('validateSettings: unknown key stripped (additionalProperties:false)', () => {
  const res = validateSettings(
    { defaultView: 'list', hacker: 'x' },
    { defaultView: ['list', 'grid'] },
  );
  assert.equal(res.valid, false);
  assert.deepEqual(res.value, { defaultView: 'list' });
  assert.equal(res.errors[0].path, '/hacker');
});

test('validateSettings: array-typed field accepts arrays, rejects scalars', () => {
  const ok = validateSettings({ pinnedReports: ['r1', 'r2'] }, { pinnedReports: ['array'] });
  assert.equal(ok.valid, true);
  assert.deepEqual(ok.value, { pinnedReports: ['r1', 'r2'] });

  const bad = validateSettings({ pinnedReports: 'r1' }, { pinnedReports: ['array'] });
  assert.equal(bad.valid, false);
  assert.deepEqual(bad.value, {});
});

test('validateSettings: boolean field', () => {
  assert.equal(
    validateSettings({ hotkeyEnabled: true }, { hotkeyEnabled: 'boolean' }).valid,
    true,
  );
  assert.equal(
    validateSettings({ hotkeyEnabled: 'yes' }, { hotkeyEnabled: 'boolean' }).valid,
    false,
  );
});

test('validateSettings: non-object input → empty + error', () => {
  const res = validateSettings('nope', { defaultView: ['list', 'grid'] });
  assert.equal(res.valid, false);
  assert.deepEqual(res.value, {});
});

// ── compatibility: sanitize behaviour via normalizeModuleConfigs ─────────────
test('sanitize compat: keeps valid, drops unknown + bad-typed', () => {
  const configs = normalizeModuleConfigs(['search'], [
    {
      moduleId: 'search',
      enabled: true,
      personalSettings: {
        defaultScope: 'contacts', // valid enum
        minQueryChars: 3, // valid number
        hotkeyEnabled: 'nope', // wrong type → dropped
        bogus: 1, // unknown → dropped
      },
    },
  ]);
  const search = configs.find((c) => c.moduleId === 'search');
  assert.ok(search);
  assert.deepEqual(search!.personalSettings, {
    defaultScope: 'contacts',
    minQueryChars: 3,
  });
});

test('sanitize compat: empty-schema module drops everything', () => {
  // statistics has empty personal/integration schemas
  assert.deepEqual(MODULE_REGISTRY.statistics.personalSettingsSchema, {});
  const configs = normalizeModuleConfigs(['statistics'], [
    { moduleId: 'statistics', enabled: true, personalSettings: { anything: 1 } },
  ]);
  const stats = configs.find((c) => c.moduleId === 'statistics');
  assert.deepEqual(stats!.personalSettings, {});
});
