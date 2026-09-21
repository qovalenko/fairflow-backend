import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * NFR-520 — CI barrier: a domain service must not serve business logic over HTTP.
 *
 * Client authorization (end-user JWT) lives on the gateway only; domain services
 * trust gRPC metadata (`x-service-api-key` + gateway headers) and never parse a
 * user token. Therefore any HTTP route in a domain other than the four
 * operational ones is, by construction, a way around the gateway's auth.
 *
 * The allowed surface is the `ops-http-contract` from `@fairflow/shared`:
 * `GET /healthz`, `GET /readyz`, `GET /status`, `GET /metrics`.
 *
 * The gateway is deliberately out of scope — it IS the public entry point and
 * its `/api/...` REST surface is the contract.
 *
 * Detection is regex-over-source (same approach as NFR-510 / NFR-550): no AST,
 * no Nest bootstrap, so the barrier stays cheap and formatting-tolerant.
 */
describe('NFR-520 domain HTTP surface barrier', () => {
  const repoRoot = path.resolve(__dirname, '../../..');

  /** Every service workspace except `gateway` (see the note above). */
  const DOMAIN_SERVICES = [
    'activity',
    'audit',
    'auth',
    'automation',
    'billing',
    'chat',
    'company',
    'contact',
    'control',
    'documents',
    'notification',
    'orders',
    'pipe',
    'platform',
    'product',
    'reports',
    'search',
  ] as const;

  /** The only HTTP routes a domain is allowed to answer (ops-http-contract). */
  const OPS_ROUTES = ['GET /healthz', 'GET /readyz', 'GET /status', 'GET /metrics'] as const;
  const OPS_ROUTE_SET: ReadonlySet<string> = new Set(OPS_ROUTES);

  /** Nest HTTP verb decorators; `@GrpcMethod` handlers carry none of these. */
  const HTTP_VERBS = [
    'Get',
    'Post',
    'Put',
    'Patch',
    'Delete',
    'All',
    'Head',
    'Options',
    'Search',
    'Sse',
  ] as const;

  interface ControllerClass {
    /** Repo-relative path, for a message an engineer can act on. */
    file: string;
    className: string;
    /** `METHOD /path` strings, e.g. `GET /healthz`, `POST /api-keys/introspect`. */
    routes: string[];
  }

  function walk(dir: string, accept: (name: string) => boolean): string[] {
    if (!fs.existsSync(dir)) return [];
    const out: string[] = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) out.push(...walk(full, accept));
      else if (accept(entry.name)) out.push(full);
    }
    return out;
  }

  /**
   * Reads the single argument of a decorator call. Returns the string literal
   * when there is one, `''` for a bare `@Get()`, and `undefined` when the path
   * is computed — the barrier cannot prove a computed path stays inside the ops
   * contract, so callers must treat `undefined` as a violation.
   */
  function readPathArgument(rawArgs: string): string | undefined {
    const arg = rawArgs.trim();
    if (arg === '') return '';
    const literal = /^(['"`])([^'"`]*)\1$/.exec(arg);
    return literal ? literal[2] : undefined;
  }

  /** `('api-keys', 'introspect')` -> `/api-keys/introspect`; empty parts drop out. */
  function joinRoute(...parts: string[]): string {
    const segments = parts
      .flatMap((part) => part.split('/'))
      .map((segment) => segment.trim())
      .filter((segment) => segment.length > 0);
    return `/${segments.join('/')}`;
  }

  /**
   * Splits a controller file into per-`@Controller` chunks (a file may declare
   * more than one class) and extracts the routes each class declares.
   */
  function parseControllerFile(file: string): ControllerClass[] {
    const src = fs.readFileSync(file, 'utf8');
    const relFile = path.relative(repoRoot, file);
    const decoratorRe = /@Controller\(([^)]*)\)/g;

    const starts: { index: number; args: string }[] = [];
    let match: RegExpExecArray | null;
    while ((match = decoratorRe.exec(src))) {
      starts.push({ index: match.index, args: match[1] });
    }

    return starts.map((start, i) => {
      const chunk = src.slice(start.index, starts[i + 1]?.index ?? src.length);
      const className = /class\s+([A-Za-z0-9_$]+)/.exec(chunk)?.[1] ?? '<anonymous>';
      const prefix = readPathArgument(start.args);
      const verbRe = new RegExp(`@(${HTTP_VERBS.join('|')})\\(([^)]*)\\)`, 'g');

      const routes: string[] = [];
      let verbMatch: RegExpExecArray | null;
      while ((verbMatch = verbRe.exec(chunk))) {
        const verb = verbMatch[1].toUpperCase();
        const sub = readPathArgument(verbMatch[2]);
        routes.push(
          prefix === undefined || sub === undefined
            ? `${verb} <computed path>`
            : `${verb} ${joinRoute(prefix, sub)}`,
        );
      }
      return { file: relFile, className, routes };
    });
  }

  /**
   * Controller classes a Nest module actually registers. Nest mounts routes only
   * for classes listed in some `@Module({ controllers: [...] })`; a controller no
   * module references serves nothing, and wiring it later trips this barrier.
   */
  function collectWiredControllers(domain: string): ReadonlySet<string> {
    const wired = new Set<string>();
    const modules = walk(
      path.join(repoRoot, domain, 'src'),
      (name) => name.endsWith('.module.ts') && !name.endsWith('.spec.ts'),
    );
    for (const file of modules) {
      const src = fs.readFileSync(file, 'utf8');
      const listRe = /controllers:\s*\[([^\]]*)\]/g;
      let match: RegExpExecArray | null;
      while ((match = listRe.exec(src))) {
        for (const raw of match[1].split(',')) {
          const name = raw.trim();
          if (/^[A-Za-z0-9_$]+$/.test(name)) wired.add(name);
        }
      }
    }
    return wired;
  }

  /** Every module-registered controller class of a domain, with its routes. */
  function collectMountedControllers(domain: string): ControllerClass[] {
    const wired = collectWiredControllers(domain);
    return walk(
      path.join(repoRoot, domain, 'src'),
      (name) => name.endsWith('.controller.ts') && !name.endsWith('.spec.ts'),
    )
      .flatMap(parseControllerFile)
      .filter((controller) => wired.has(controller.className));
  }

  it('domain services expose no HTTP route beyond the ops-http-contract', () => {
    const offenders: string[] = [];
    for (const domain of DOMAIN_SERVICES) {
      for (const controller of collectMountedControllers(domain)) {
        for (const route of controller.routes) {
          if (OPS_ROUTE_SET.has(route)) continue;
          offenders.push(
            `${domain}: ${controller.file} (${controller.className}) serves HTTP "${route}" — ` +
              `a domain may answer only the ops-http-contract routes [${OPS_ROUTES.join(', ')}]; ` +
              'any other HTTP route bypasses the gateway, which is the only place the end-user ' +
              'JWT is verified (domains trust gRPC metadata). Move the logic to gRPC + a gateway BFF endpoint.',
          );
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('every domain service implements the full ops-http-contract', () => {
    const offenders: string[] = [];
    for (const domain of DOMAIN_SERVICES) {
      const served = new Set(
        collectMountedControllers(domain).flatMap((controller) => controller.routes),
      );
      const missing = OPS_ROUTES.filter((route) => !served.has(route));
      if (missing.length > 0) {
        offenders.push(
          `${domain}: no module-registered controller serves [${missing.join(', ')}] — ` +
            'the ops-http-contract from @fairflow/shared is mandatory for every service ' +
            '(probes, readiness gating and Prometheus scraping depend on it).',
        );
      }
    }
    expect(offenders).toEqual([]);
  });

  it('the barrier covers every service workspace except the gateway', () => {
    const services = fs
      .readdirSync(repoRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
      .map((entry) => entry.name)
      .filter((name) => fs.existsSync(path.join(repoRoot, name, 'src', 'main.ts')))
      .filter((name) => name !== 'gateway');

    const uncovered = services.filter(
      (name) => !(DOMAIN_SERVICES as readonly string[]).includes(name),
    );
    expect(uncovered).toEqual([]);
  });
});
