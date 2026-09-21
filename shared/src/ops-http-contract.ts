/**
 * Standard ops surface for every Fairflow HTTP process (root paths, no /api prefix):
 *
 * | Method | Path      | Success | Failure |
 * |--------|-----------|---------|---------|
 * | GET    | /healthz  | 200 `{ status: "ok" }` | — |
 * | GET    | /readyz   | 200 `{ status: "ok" }` | 503 `{ status: "error", message: string }` |
 * | GET    | /status   | 200 `OpsStatusBody` (see below) | — |
 * | GET    | /metrics  | 200 Prometheus text, Content-Type below | — |
 *
 * `/status` payload:
 * ```
 * {
 *   status: "ok",
 *   timestamp: ISO8601,   // moment the request was served
 *   service: string,      // service name (package.json name)
 *   version: string,      // service version (package.json version)
 *   commit: string,       // GIT_COMMIT | COMMIT_SHA | IMAGE_TAG | "unknown"
 *   bootTime: ISO8601,    // process start time
 *   uptimeSec: number     // whole seconds since process start
 * }
 * ```
 * Build the body with {@link buildOpsStatus}; every service's HealthController just
 * returns `buildOpsStatus()` so the shape stays identical across all processes.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export const OPS_METRICS_CONTENT_TYPE = 'text/plain; version=0.0.4';

export type OpsHealthzBody = { status: 'ok' };
export type OpsReadyzOkBody = { status: 'ok' };
export type OpsReadyzErrorBody = { status: 'error'; message: string };
export type OpsStatusBody = {
  status: 'ok';
  timestamp: string;
  service: string;
  version: string;
  commit: string;
  bootTime: string;
  uptimeSec: number;
};

/**
 * Process start time, derived once from `process.uptime()` at module load so it
 * reflects the real boot moment regardless of when the module is first imported.
 */
const PROCESS_START_MS = Date.now() - Math.round(process.uptime() * 1000);

type PkgInfo = { name?: string; version?: string };

let cwdPkgCache: PkgInfo | undefined;

function readCwdPkg(): PkgInfo {
  if (cwdPkgCache !== undefined) {
    return cwdPkgCache;
  }
  try {
    const raw = readFileSync(join(process.cwd(), 'package.json'), 'utf8');
    const json = JSON.parse(raw) as PkgInfo;
    cwdPkgCache = { name: json.name, version: json.version };
  } catch {
    cwdPkgCache = {};
  }
  return cwdPkgCache;
}

function resolveCommit(): string {
  return (
    process.env.GIT_COMMIT ??
    process.env.COMMIT_SHA ??
    process.env.IMAGE_TAG ??
    'unknown'
  );
}

export interface BuildOpsStatusOptions {
  /** Override the reported service name (defaults to package.json name). */
  service?: string;
  /** Override the reported version (defaults to package.json version). */
  version?: string;
  /** Explicit package info; skips the cwd package.json lookup when provided. */
  pkg?: PkgInfo;
}

/**
 * Builds the standard `/status` body. Services call this with no arguments; the
 * name/version fall back to the cwd `package.json` (then `npm_package_*` env),
 * commit comes from CI-provided env, and boot-time/uptime are process-derived.
 */
export function buildOpsStatus(opts: BuildOpsStatusOptions = {}): OpsStatusBody {
  const pkg = opts.pkg ?? readCwdPkg();
  const service =
    opts.service ?? pkg.name ?? process.env.npm_package_name ?? 'unknown';
  const version =
    opts.version ?? pkg.version ?? process.env.npm_package_version ?? '0.0.0';

  return {
    status: 'ok',
    timestamp: new Date().toISOString(),
    service,
    version,
    commit: resolveCommit(),
    bootTime: new Date(PROCESS_START_MS).toISOString(),
    uptimeSec: Math.floor(process.uptime()),
  };
}
