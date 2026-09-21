/**
 * Process-level safety net for background failures.
 *
 * Node terminates the process on an unhandled promise rejection (default since
 * Node 15) and on an uncaught exception. Without a handler the crash is emitted
 * to stderr in an unstructured, hard-to-correlate form (and, for older code
 * paths, may be swallowed). This util installs a single structured handler so a
 * background reject/throw always leaves a readable, log-aggregator-friendly
 * trace before the process exits.
 *
 * Storage-agnostic: services pass their own structured logger (e.g. the pino
 * logger already built at bootstrap). When none is supplied, a minimal
 * one-line-JSON fallback on stderr is used so shared carries no logging deps.
 */

/** Minimal structured-logger surface (pino-compatible: `error(obj, msg)`). */
export interface StructuredErrorLogger {
  error(obj: unknown, msg?: string): void;
  warn?(obj: unknown, msg?: string): void;
}

export interface InstallProcessHandlersOptions {
  /** Structured logger (pino-compatible). Falls back to one-line-JSON stderr. */
  logger?: StructuredErrorLogger;
  /** Service name stamped into every record for correlation. */
  service?: string;
  /**
   * Exit the process after an uncaughtException (recommended: the process is in
   * an undefined state). Default: true. Unhandled rejections are logged but do
   * NOT exit by default (matches Node's warn-and-continue intent for a single
   * stray reject, while still leaving a trace).
   */
  exitOnUncaught?: boolean;
  /** Exit code used when exiting after uncaughtException. Default: 1. */
  exitCode?: number;
}

/** Serialize an error/reason into a plain object safe for structured logging. */
function serializeReason(reason: unknown): Record<string, unknown> {
  if (reason instanceof Error) {
    return { name: reason.name, message: reason.message, stack: reason.stack };
  }
  if (typeof reason === 'object' && reason !== null) {
    try {
      return { value: JSON.parse(JSON.stringify(reason)) as unknown };
    } catch {
      return { value: String(reason) };
    }
  }
  return { value: String(reason) };
}

function fallbackLogger(): StructuredErrorLogger {
  return {
    error(obj: unknown, msg?: string) {
      try {
        // eslint-disable-next-line no-console
        console.error(JSON.stringify({ level: 'error', msg, ...(obj as object) }));
      } catch {
        // eslint-disable-next-line no-console
        console.error(msg ?? 'process handler error', obj);
      }
    },
  };
}

/**
 * Install unhandledRejection + uncaughtException handlers. Idempotent per
 * process: repeated calls are ignored so multiple bootstrap paths (or tests)
 * cannot stack duplicate handlers.
 */
let installed = false;
export function installProcessHandlers(options: InstallProcessHandlersOptions = {}): void {
  if (installed) return;
  installed = true;

  const log = options.logger ?? fallbackLogger();
  const service = options.service;
  const exitOnUncaught = options.exitOnUncaught !== false;
  const exitCode = options.exitCode ?? 1;

  process.on('unhandledRejection', (reason: unknown, promise: Promise<unknown>) => {
    log.error(
      { service, kind: 'unhandledRejection', promise: String(promise), ...serializeReason(reason) },
      'Unhandled promise rejection',
    );
  });

  process.on('uncaughtException', (err: Error, origin: string) => {
    log.error(
      { service, kind: 'uncaughtException', origin, ...serializeReason(err) },
      'Uncaught exception',
    );
    if (exitOnUncaught) {
      // Process is in an undefined state — flush what we can and exit so an
      // orchestrator (k8s) restarts a clean instance instead of limping on.
      process.exitCode = exitCode;
      // Give async transports a tick to flush before exiting.
      setImmediate(() => process.exit(exitCode));
    }
  });
}

/** Test-only reset of the idempotency latch. */
export function __resetProcessHandlersForTest(): void {
  installed = false;
}
