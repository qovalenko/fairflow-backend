/**
 * PIN TEST — repo-wide gRPC proto-loader options.
 *
 * The "incomplete loader" defect has shipped FOUR times (see `loader-options.ts`
 * for the incident log): three times `keepCase` was missing and every snake_case
 * field was silently dropped, once `longs` was missing and every int64 arrived as
 * a `Long {low,high,unsigned}` object masquerading as `number`. All four were
 * invisible to `tsc` and to every unit test — proto-loader options are untyped
 * knobs and each broken config is a perfectly legal one.
 *
 * So the guard has to be structural, and it has to read the REAL SOURCES rather
 * than a hand-kept list: a list is exactly what a fifth incident would walk past
 * (a new service is registered, nobody remembers to add it, the check stays
 * green). This test therefore walks the whole backend workspace, finds EVERY
 * place a gRPC client or server is created, resolves the loader options through
 * identifiers/spreads/helper calls across files, and fails when a site is missing
 * `keepCase: true` or has no deliberate `longs`.
 *
 * `longs: String` is accepted alongside `longs: Number`: a string is a lossless
 * int64 and is legitimate for opaque/oversized ids, as long as somebody CHOSE it.
 * What is rejected is the absence of the key — the state the fourth incident was.
 *
 * Scope: `.spec.ts` files are skipped. Loaders inside tests are fixtures that
 * deliberately exercise partial configs (e.g. Struct decoding without `longs`),
 * and they never talk to a live peer.
 *
 * The last `describe` in this file is a meta-test: it runs the same analyzer over
 * synthetic broken sources and asserts each defect class is caught. A pin test
 * that cannot go red pins nothing.
 */

import { mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';

import { CANONICAL_GRPC_LOADER_OPTIONS, buildGrpcLoaderOptions } from './loader-options';

// ─────────────────────────────────────────────────────────────────────────────
// source scanning
// ─────────────────────────────────────────────────────────────────────────────

const SKIP_DIRS = new Set(['node_modules', 'dist', 'generated', '.git', 'coverage', 'build']);

/** Backend monorepo root = nearest ancestor package.json declaring workspaces. */
function findWorkspaceRoot(from: string): string {
  let dir = from;
  for (let i = 0; i < 10; i++) {
    const pkg = join(dir, 'package.json');
    try {
      if (Array.isArray((JSON.parse(readFileSync(pkg, 'utf8')) as { workspaces?: unknown }).workspaces)) {
        return dir;
      }
    } catch {
      /* no package.json here (or unreadable) — keep climbing */
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(`cannot locate the backend workspace root above ${from}`);
}

function listSources(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      if (SKIP_DIRS.has(entry)) continue;
      const p = join(dir, entry);
      if (statSync(p).isDirectory()) walk(p);
      else if (entry.endsWith('.ts') && !entry.endsWith('.d.ts') && !entry.endsWith('.spec.ts')) out.push(p);
    }
  };
  walk(root);
  return out;
}

/**
 * Blank out comments while preserving offsets (so line numbers stay exact) and
 * without touching string literals — a naive `//` strip mangles urls and, worse,
 * unbalances the braces we rely on.
 */
function blankComments(src: string): string {
  const out = src.split('');
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === '"' || c === "'" || c === '`') {
      i = skipString(src, i);
      continue;
    }
    if (c === '/' && src[i + 1] === '/') {
      while (i < src.length && src[i] !== '\n') out[i++] = ' ';
      continue;
    }
    if (c === '/' && src[i + 1] === '*') {
      while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) {
        if (src[i] !== '\n') out[i] = ' ';
        i++;
      }
      if (i < src.length) {
        out[i] = ' ';
        out[i + 1] = ' ';
        i += 2;
      }
      continue;
    }
    i++;
  }
  return out.join('');
}

/** Index just past the string literal opening at `start`. */
function skipString(src: string, start: number): number {
  const quote = src[start];
  let i = start + 1;
  while (i < src.length) {
    if (src[i] === '\\') {
      i += 2;
      continue;
    }
    if (src[i] === quote) return i + 1;
    i++;
  }
  return i;
}

/** Index of the bracket matching the one at `open`, or -1 when unbalanced. */
function matchBracket(src: string, open: number): number {
  let depth = 0;
  let i = open;
  while (i < src.length) {
    const c = src[i];
    if (c === '"' || c === "'" || c === '`') {
      i = skipString(src, i);
      continue;
    }
    if (c === '{' || c === '(' || c === '[') depth++;
    else if (c === '}' || c === ')' || c === ']') {
      depth--;
      if (depth === 0) return i;
    }
    i++;
  }
  return -1;
}

/** Split an object/argument body on its top-level commas. */
function splitTopLevel(body: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  let i = 0;
  while (i < body.length) {
    const c = body[i];
    if (c === '"' || c === "'" || c === '`') {
      i = skipString(body, i);
      continue;
    }
    if (c === '{' || c === '(' || c === '[') depth++;
    else if (c === '}' || c === ')' || c === ']') depth--;
    else if (c === ',' && depth === 0) {
      parts.push(body.slice(start, i));
      start = i + 1;
    }
    i++;
  }
  parts.push(body.slice(start));
  return parts.map((p) => p.trim()).filter((p) => p.length > 0);
}

interface ObjectLiteral {
  props: Map<string, string>;
  spreads: string[];
}

function objectEntries(body: string): ObjectLiteral {
  const props = new Map<string, string>();
  const spreads: string[] = [];
  for (const part of splitTopLevel(body)) {
    if (part.startsWith('...')) {
      spreads.push(part.slice(3).trim());
      continue;
    }
    const m = /^(?:'([^']+)'|"([^"]+)"|([A-Za-z_$][\w$]*))\s*:\s*([\s\S]+)$/.exec(part);
    if (m) props.set(m[1] ?? m[2] ?? m[3], m[4].trim());
    else if (/^[A-Za-z_$][\w$]*$/.test(part)) props.set(part, part); // shorthand
  }
  return { props, spreads };
}

/** Read one expression at `start`: object/array literal, call, or identifier. */
function readExpression(src: string, start: number): string | null {
  let i = start;
  while (i < src.length && /\s/.test(src[i])) i++;
  if (src[i] === '{' || src[i] === '(' || src[i] === '[') {
    const end = matchBracket(src, i);
    return end < 0 ? null : src.slice(i, end + 1);
  }
  const m = /^[A-Za-z_$][\w$.]*/.exec(src.slice(i));
  if (!m) return null;
  let expr = m[0];
  let j = i + m[0].length;
  while (j < src.length && /\s/.test(src[j])) j++;
  if (src[j] === '(') {
    const end = matchBracket(src, j);
    if (end >= 0) expr += src.slice(j, end + 1);
  }
  return expr;
}

interface Declaration {
  file: string;
  expr: string;
}

/** `const NAME = <expr>` across the workspace, so cross-file constants resolve. */
function buildDeclarationIndex(sources: Map<string, string>): Map<string, Declaration[]> {
  const index = new Map<string, Declaration[]>();
  for (const [file, src] of sources) {
    const re = /(?:export\s+)?const\s+([A-Za-z_$][\w$]*)\s*(?::[^=;]*)?=\s*/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(src))) {
      const expr = readExpression(src, m.index + m[0].length);
      if (!expr) continue;
      const list = index.get(m[1]) ?? [];
      list.push({ file, expr });
      index.set(m[1], list);
    }
  }
  return index;
}

// ─────────────────────────────────────────────────────────────────────────────
// option resolution
// ─────────────────────────────────────────────────────────────────────────────

/** Textual mirror of CANONICAL_GRPC_LOADER_OPTIONS (asserted equal below). */
const CANON_TEXT: Record<string, string> = { keepCase: 'true', longs: 'Number', arrays: 'true' };

/** Factories known to start from the canonical baseline. */
const CANONICAL_FACTORIES = new Set(['buildGrpcLoaderOptions']);

const PINNED_KEYS = ['keepCase', 'longs', 'arrays'] as const;
type PinnedKey = (typeof PINNED_KEYS)[number];

interface ResolvedOptions {
  keepCase?: string;
  longs?: string;
  arrays?: string;
  unresolved: string[];
}

function resolveOptions(
  expr: string,
  file: string,
  index: Map<string, Declaration[]>,
  seen: Set<string> = new Set(),
  depth = 0,
): ResolvedOptions {
  const result: ResolvedOptions = { unresolved: [] };
  if (depth > 8) {
    result.unresolved.push(`resolution depth exceeded at \`${expr.slice(0, 40)}\``);
    return result;
  }
  const text = expr.trim().replace(/\s+as\s+const$/, '');

  const freeze = /^Object\.freeze\s*\(/.exec(text);
  if (freeze) {
    const inner = text.slice(freeze[0].length - 1);
    const end = matchBracket(inner, 0);
    return resolveOptions(inner.slice(1, end < 0 ? inner.length : end), file, index, seen, depth + 1);
  }

  if (text.startsWith('{')) {
    const end = matchBracket(text, 0);
    const { props, spreads } = objectEntries(text.slice(1, end < 0 ? text.length : end));
    for (const spread of spreads) {
      const sub = resolveOptions(spread, file, index, seen, depth + 1);
      for (const k of PINNED_KEYS) if (sub[k] !== undefined) result[k] = sub[k];
      result.unresolved.push(...sub.unresolved);
    }
    for (const k of PINNED_KEYS) {
      const v = props.get(k);
      if (v !== undefined) result[k] = v.replace(/\s+/g, ' ').trim();
    }
    return result;
  }

  const call = /^([A-Za-z_$][\w$.]*)\s*\(/.exec(text);
  if (call) {
    const name = call[1].split('.').pop() as string;
    if (!CANONICAL_FACTORIES.has(name)) {
      result.unresolved.push(
        `loader options come from \`${name}()\`, which is not a known canonical factory — ` +
          'use buildGrpcLoaderOptions() from @fairflow/shared',
      );
      return result;
    }
    const argsText = text.slice(call[0].length - 1);
    const end = matchBracket(argsText, 0);
    const args = splitTopLevel(argsText.slice(1, end < 0 ? argsText.length : end));
    Object.assign(result, CANON_TEXT);
    if (args.length > 0) {
      const sub = resolveOptions(args[0], file, index, seen, depth + 1);
      for (const k of PINNED_KEYS) if (sub[k] !== undefined) result[k] = sub[k];
      result.unresolved.push(...sub.unresolved);
    }
    return result;
  }

  if (/^[A-Za-z_$][\w$]*$/.test(text)) {
    if (seen.has(text)) {
      result.unresolved.push(`cyclic loader-options identifier \`${text}\``);
      return result;
    }
    seen.add(text);
    const decls = index.get(text) ?? [];
    const local = decls.filter((d) => d.file === file);
    const chosen = local.length > 0 ? local : decls;
    if (chosen.length === 0) {
      result.unresolved.push(`cannot resolve loader-options identifier \`${text}\``);
      return result;
    }
    return resolveOptions(chosen[0].expr, chosen[0].file, index, seen, depth + 1);
  }

  result.unresolved.push(`unsupported loader-options expression \`${text.slice(0, 60)}\``);
  return result;
}

// ─────────────────────────────────────────────────────────────────────────────
// site discovery
// ─────────────────────────────────────────────────────────────────────────────

interface Site {
  file: string;
  abs: string;
  line: number;
  /** Raw loader expression, or null when the site has no loader at all. */
  expr: string | null;
  missing: string | null;
}

function lineOf(src: string, idx: number): number {
  return src.slice(0, idx).split('\n').length;
}

function findSites(abs: string, rel: string, src: string): Site[] {
  const sites: Site[] = [];

  // (a) Nest transports — client registrations and server bootstraps alike:
  //     `transport: Transport.GRPC` followed by its `options: { … }` object.
  const transportIdx: number[] = [];
  const transportRe = /Transport\.GRPC/g;
  let m: RegExpExecArray | null;
  while ((m = transportRe.exec(src))) transportIdx.push(m.index);

  for (let k = 0; k < transportIdx.length; k++) {
    const from = transportIdx[k];
    const stop = k + 1 < transportIdx.length ? transportIdx[k + 1] : src.length;
    const optRe = /\boptions\s*:\s*\{/g;
    optRe.lastIndex = from;
    const om = optRe.exec(src);
    if (!om || om.index >= stop) {
      sites.push({
        file: rel,
        abs,
        line: lineOf(src, from),
        expr: null,
        missing: 'gRPC transport registered without an `options` block',
      });
      continue;
    }
    const open = om.index + om[0].length - 1;
    const close = matchBracket(src, open);
    const { props } = objectEntries(src.slice(open + 1, close < 0 ? src.length : close));
    const loader = props.get('loader') ?? null;
    sites.push({
      file: rel,
      abs,
      line: lineOf(src, from),
      expr: loader,
      missing: loader ? null : 'gRPC transport registered without a `loader` config (proto-loader defaults apply)',
    });
  }

  // (b) direct proto-loader use (reflection, tooling)
  const loadRe = /\bloadSync\s*\(/g;
  while ((m = loadRe.exec(src))) {
    const open = m.index + m[0].length - 1;
    const close = matchBracket(src, open);
    const args = splitTopLevel(src.slice(open + 1, close < 0 ? src.length : close));
    sites.push({
      file: rel,
      abs,
      line: lineOf(src, m.index),
      expr: args[1] ?? null,
      missing: args[1] ? null : '`loadSync()` called without an options argument',
    });
  }

  return sites;
}

interface Violation {
  file: string;
  line: number;
  reason: string;
}

interface ScanResult {
  sites: Array<Site & { resolved?: ResolvedOptions }>;
  violations: Violation[];
}

function scan(root: string): ScanResult {
  const sources = new Map<string, string>();
  for (const f of listSources(root)) sources.set(f, blankComments(readFileSync(f, 'utf8')));
  const index = buildDeclarationIndex(sources);

  const sites: Array<Site & { resolved?: ResolvedOptions }> = [];
  for (const [abs, src] of sources) {
    if (!/Transport\.GRPC|loadSync\s*\(/.test(src)) continue;
    sites.push(...findSites(abs, relative(root, abs), src));
  }

  const violations: Violation[] = [];
  for (const site of sites) {
    if (!site.expr) {
      violations.push({ file: site.file, line: site.line, reason: site.missing as string });
      continue;
    }
    const resolved = resolveOptions(site.expr, site.abs, index);
    site.resolved = resolved;
    const problems: string[] = [];
    if (resolved.keepCase !== 'true') {
      problems.push(
        `keepCase is \`${resolved.keepCase ?? 'absent'}\` — must be true (snake_case contract; ` +
          'without it every multi-word field is silently dropped)',
      );
    }
    if (resolved.longs !== 'Number' && resolved.longs !== 'String') {
      problems.push(
        `longs is \`${resolved.longs ?? 'absent'}\` — must be an explicit Number (canonical) or ` +
          'String (justified); the default decodes int64 as a Long object typed as number',
      );
    }
    problems.push(...resolved.unresolved);
    if (problems.length > 0) {
      violations.push({ file: site.file, line: site.line, reason: problems.join('; ') });
    }
  }

  return { sites, violations };
}

function format(violations: Violation[]): string {
  return violations.map((v) => `  ${v.file}:${v.line}\n      ${v.reason}`).join('\n');
}

// ─────────────────────────────────────────────────────────────────────────────
// the pin
// ─────────────────────────────────────────────────────────────────────────────

const ROOT = findWorkspaceRoot(__dirname);
const RESULT = scan(ROOT);

describe('gRPC proto-loader options (repo-wide pin)', () => {
  it('the shared canon carries all three silent-data-loss options', () => {
    expect(CANONICAL_GRPC_LOADER_OPTIONS.keepCase).toBe(true);
    expect(CANONICAL_GRPC_LOADER_OPTIONS.longs).toBe(Number);
    expect(CANONICAL_GRPC_LOADER_OPTIONS.arrays).toBe(true);
    // The scanner compares source text, so its mirror must track the real canon.
    expect(CANON_TEXT).toEqual({ keepCase: 'true', longs: 'Number', arrays: 'true' });
  });

  it('buildGrpcLoaderOptions keeps the canon and applies justified overrides', () => {
    expect(buildGrpcLoaderOptions()).toEqual({ keepCase: true, longs: Number, arrays: true });
    expect(buildGrpcLoaderOptions({ longs: String, defaults: true })).toEqual({
      keepCase: true,
      longs: String,
      arrays: true,
      defaults: true,
    });
    // frozen: a caller must not be able to mutate the baseline for everyone else
    expect(Object.isFrozen(CANONICAL_GRPC_LOADER_OPTIONS)).toBe(true);
  });

  it('finds every gRPC client/server registration in the workspace', () => {
    // Sanity floor: if the walker silently stops finding sources (wrong root,
    // renamed dirs), the pin below would pass vacuously. 18 workspaces register
    // far more than 30 clients/servers between them.
    expect(RESULT.sites.length).toBeGreaterThan(30);
  });

  it('every registration sets keepCase:true and a deliberate longs', () => {
    expect(
      RESULT.violations.length === 0
        ? ''
        : `\n${RESULT.violations.length} gRPC loader config(s) violate the canon ` +
            '(see shared/src/grpc/loader-options.ts):\n' +
            `${format(RESULT.violations)}\n`,
    ).toBe('');
  });

  it('does not let new registrations drop arrays:true (ratchet)', () => {
    // `arrays:true` is canonical too, but ~25 server bootstraps predate the canon
    // and changing their decoding is not a test's call. So instead of a blanket
    // assert, this ratchets: the FILES that lack it are frozen. Do not append to
    // this list — new code uses buildGrpcLoaderOptions(), which carries arrays.
    const GRANDFATHERED = new Set([
      'activity/src/main.ts',
      'billing/src/main.ts',
      'chat/src/main.ts',
      'company/src/main.ts',
      'contact/src/main.ts',
      'control/src/main.ts',
      'control/src/provisioning/provisioning.module.ts',
      'orders/src/main.ts',
      'orders/src/orders/orders.module.ts',
      'pipe/src/main.ts',
      'product/src/main.ts',
      'product/src/usage/usage.module.ts',
      'reports/src/main.ts',
      'reports/src/reports/reports.module.ts',
      'shared/src/grpc/nest-grpc-reflection.ts',
    ]);
    const offenders = [
      ...new Set(
        RESULT.sites
          .filter((s) => s.resolved && s.resolved.arrays !== 'true' && !GRANDFATHERED.has(s.file))
          .map((s) => s.file),
      ),
    ];
    expect(
      offenders.length === 0
        ? ''
        : `\nloader config(s) without \`arrays: true\` (empty repeated decodes as undefined):\n  ${offenders.join(
            '\n  ',
          )}\n`,
    ).toBe('');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// meta: the pin must be able to go red
// ─────────────────────────────────────────────────────────────────────────────

describe('gRPC loader pin — catches every defect class (meta)', () => {
  let fixtureRoot: string;

  const write = (rel: string, body: string): void => {
    const p = join(fixtureRoot, rel);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, body);
  };

  beforeAll(() => {
    fixtureRoot = mkdtempSync(join(tmpdir(), 'ff-loader-pin-'));
    write('package.json', JSON.stringify({ workspaces: ['svc'] }));

    // 1. no loader at all — the P8 ValidateServiceApiKey shape
    write(
      'svc/no-loader.ts',
      `ClientsModule.register([{ name: 'X', transport: Transport.GRPC,
         options: { package: 'p', protoPath: 'p.proto', url: 'u' } }]);`,
    );
    // 2. keepCase missing — incidents 1-3
    write(
      'svc/no-keepcase.ts',
      `const o = { transport: Transport.GRPC,
         options: { url: 'u', loader: { longs: Number, arrays: true } } };`,
    );
    // 3. longs missing — incident 4
    write(
      'svc/no-longs.ts',
      `const o = { transport: Transport.GRPC,
         options: { url: 'u', loader: { keepCase: true, arrays: true } } };`,
    );
    // 4. keepCase turned off explicitly
    write(
      'svc/keepcase-false.ts',
      `const o = { transport: Transport.GRPC,
         options: { url: 'u', loader: { keepCase: false, longs: Number } } };`,
    );
    // 5. options hidden behind an unknown factory — must not pass unexamined
    write(
      'svc/opaque-factory.ts',
      `const o = { transport: Transport.GRPC,
         options: { url: 'u', loader: makeLoaderOptions({ keepCase: true, longs: Number }) } };`,
    );
    // 6. options behind an unresolvable identifier
    write(
      'svc/dangling-const.ts',
      `const o = { transport: Transport.GRPC,
         options: { url: 'u', loader: OPTIONS_FROM_SOMEWHERE_ELSE } };`,
    );
    // 7. loadSync without options
    write('svc/loadsync-bare.ts', `const pkg = protoLoader.loadSync(protoPath);`);
    // 8. a broken constant reached through a cross-file identifier + spread —
    //    the indirection the four real incidents hid behind
    write('svc/bad-shared-const.ts', `export const SHARED_BAD = { longs: Number };`);
    write(
      'svc/uses-bad-shared-const.ts',
      `const o = { transport: Transport.GRPC,
         options: { url: 'u', loader: { ...SHARED_BAD, defaults: true } } };`,
    );
    // 9. correct ones — must NOT be flagged (the pin has to stay useful)
    write('svc/good-const.ts', `export const GOOD = { keepCase: true, longs: String, arrays: true };`);
    write(
      'svc/good-literal.ts',
      `const o = { transport: Transport.GRPC,
         options: { url: 'u', loader: { keepCase: true, longs: Number, arrays: true } } };`,
    );
    write(
      'svc/good-via-const.ts',
      `const o = { transport: Transport.GRPC, options: { url: 'u', loader: GOOD } };`,
    );
    write(
      'svc/good-via-spread.ts',
      `const o = { transport: Transport.GRPC,
         options: { url: 'u', loader: { ...GOOD, defaults: true } } };`,
    );
    write('svc/good-loadsync.ts', `protoLoader.loadSync(p, { keepCase: true, longs: String, arrays: true });`);
  });

  afterAll(() => {
    rmSync(fixtureRoot, { recursive: true, force: true });
  });

  it('flags each broken registration and clears each correct one', () => {
    const { violations, sites } = scan(fixtureRoot);
    const flagged = new Set(violations.map((v) => v.file));

    for (const bad of [
      'svc/no-loader.ts',
      'svc/no-keepcase.ts',
      'svc/no-longs.ts',
      'svc/keepcase-false.ts',
      'svc/opaque-factory.ts',
      'svc/dangling-const.ts',
      'svc/loadsync-bare.ts',
      'svc/uses-bad-shared-const.ts',
    ]) {
      expect(`${bad}: ${flagged.has(bad) ? 'flagged' : 'MISSED'}`).toBe(`${bad}: flagged`);
    }

    for (const good of [
      'svc/good-literal.ts',
      'svc/good-via-const.ts',
      'svc/good-via-spread.ts',
      'svc/good-loadsync.ts',
    ]) {
      expect(`${good}: ${flagged.has(good) ? 'FALSE POSITIVE' : 'clean'}`).toBe(`${good}: clean`);
    }

    // 10 Transport.GRPC registrations + 2 loadSync calls across the fixture.
    expect(sites.length).toBe(12);
  });

  it('reports the specific option that is missing, not just "invalid"', () => {
    const { violations } = scan(fixtureRoot);
    const reason = (f: string): string => violations.find((v) => v.file === f)?.reason ?? '';
    expect(reason('svc/no-keepcase.ts')).toContain('keepCase');
    expect(reason('svc/no-longs.ts')).toContain('longs');
    expect(reason('svc/no-loader.ts')).toContain('without a `loader` config');
    expect(reason('svc/opaque-factory.ts')).toContain('makeLoaderOptions()');
  });
});
