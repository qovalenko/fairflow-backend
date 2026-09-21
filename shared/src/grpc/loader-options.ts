/**
 * SINGLE SOURCE OF TRUTH for `@grpc/proto-loader` options across the monorepo.
 *
 * ── Why this file exists ──────────────────────────────────────────────────────
 * The same defect has landed four times in this repository, always the same
 * shape: a gRPC client or server was registered with an INCOMPLETE `loader`
 * config, proto-loader silently applied its own defaults, and data was lost
 * without a single error being thrown:
 *
 *   1-3. `keepCase` missing → proto-loader camelCases every proto field. Our
 *        contracts are snake_case (`project_id`, `api_key`, `user_ids`), so the
 *        peer's fields simply did not match: requests arrived with the field
 *        absent (treated as "not provided"), responses decoded as `undefined`.
 *        Symptoms were always "works, but empty": ListMembers returned no
 *        members, ValidateServiceApiKey answered `{active:false}` → blanket 401.
 *   4.   `longs` missing → proto-loader decodes int64 as a protobufjs
 *        `Long {low,high,unsigned}` OBJECT while TypeScript still sees the
 *        declared `number`. `new Date(long)` → Invalid Date, `long > 0` → false,
 *        `Number(long)` → NaN. Silent corruption of every timestamp/counter.
 *
 * Each incident was found in production-ish testing, never by a type checker:
 * proto-loader options are `any`-ish by construction and every value here is a
 * legal config. Only a pin test can hold the line — see
 * `loader-options.pin.spec.ts`, which walks EVERY client/server registration in
 * the repo (reading the real sources, not a hardcoded list) and fails when one
 * of them drops `keepCase` or leaves `longs` to chance.
 *
 * ── The canonical set, option by option ───────────────────────────────────────
 * `keepCase: true`  — MANDATORY, no exceptions. Our `.proto` contracts are
 *   snake_case and every server in this repo is loaded with `keepCase: true`, so
 *   the wire-adjacent JS field names are snake_case too. A client that omits it
 *   speaks camelCase into a snake_case peer and loses every multi-word field.
 *   Both sides of a call must agree; "the peer will cope" is never true here.
 *
 * `longs: Number`   — MANDATORY to be EXPLICIT (see below for the String case).
 *   int64/uint64 in our contracts are timestamps (epoch ms) and counters — all
 *   far inside `Number.MAX_SAFE_INTEGER`. `Number` gives the plain JS number the
 *   TypeScript interfaces already claim. Leaving `longs` unset is the bug: the
 *   default is a `Long` object that lies about its own type.
 *
 * `arrays: true`    — MANDATORY. Decodes an empty `repeated` field as `[]`
 *   instead of `undefined`. Without it "no rows" and "field absent" are the same
 *   value, so every consumer needs a `?? []` and any that forgets it throws on
 *   `.map` of undefined. It also keeps list responses shape-stable for the BFF,
 *   which serialises them straight to the frontend.
 *
 * ── When `longs: String` is legitimate ────────────────────────────────────────
 * A string is a lossless representation of an int64 and is the right choice when
 * the value is only ever passed through / compared as an opaque token, or when
 * the contract may carry values beyond 2^53. That is ALLOWED — but it must be an
 * explicit, commented decision at the call site, never an accident of copy-paste.
 * Use `buildGrpcLoaderOptions({ longs: String })` and say why in a comment. The
 * pin test accepts `Number` or `String`; it rejects "no `longs` key at all".
 *
 * ── Usage ─────────────────────────────────────────────────────────────────────
 *   loader: buildGrpcLoaderOptions()                       // canonical
 *   loader: buildGrpcLoaderOptions({ defaults: true })     // canonical + extra
 *   loader: buildGrpcLoaderOptions({ longs: String })      // justified deviation
 *
 * `defaults`/`enums`/`oneofs` are deliberately NOT part of the canon: they change
 * the decoded shape (present-with-zero-value vs absent) in ways individual
 * contracts legitimately differ on, and getting them "wrong" is visible, not
 * silent. Only the three silent-data-loss options are mandated here.
 */

import type { Options as ProtoLoaderOptions } from '@grpc/proto-loader';

/** Re-exported so call sites can annotate without importing proto-loader types. */
export type GrpcLoaderOptions = ProtoLoaderOptions;

/**
 * The mandatory baseline every gRPC client/server loader in this repo must carry.
 * Frozen: it is shared by reference across modules and must never be mutated in
 * place by a caller "just adding one option".
 */
export const CANONICAL_GRPC_LOADER_OPTIONS: Readonly<ProtoLoaderOptions> = Object.freeze({
  /** snake_case contract — see file header, incidents 1-3. */
  keepCase: true,
  /** int64 → plain JS number — see file header, incident 4. */
  longs: Number,
  /** empty `repeated` → `[]`, not `undefined`. */
  arrays: true,
});

/**
 * Build proto-loader options from the canonical baseline plus per-contract
 * extras. Overrides are applied on top, so a justified `{ longs: String }` (or
 * an explicit `includeDirs`) stays possible — but `keepCase`/`arrays` are
 * inherited by default and cannot be forgotten.
 *
 * Prefer this over hand-written literals: a literal is exactly how the four
 * incidents happened.
 */
export function buildGrpcLoaderOptions(overrides: ProtoLoaderOptions = {}): ProtoLoaderOptions {
  return { ...CANONICAL_GRPC_LOADER_OPTIONS, ...overrides };
}
