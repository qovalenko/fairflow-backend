import 'reflect-metadata';
import { MODULE_METADATA } from '@nestjs/common/constants';
import { MetadataScanner } from '@nestjs/core/metadata-scanner';

/**
 * P28 — route-inventory snapshot support.
 *
 * Builds a deterministic, controller-agnostic inventory of every HTTP route
 * declared by a Nest module's controllers, read purely from decorator metadata
 * via reflection. No application bootstrap and no gRPC providers are required,
 * so the snapshot can run in plain jest.
 *
 * The inventory is the behavioural contract the BFF-split (P28) must preserve
 * byte-for-byte: HTTP method, full path, version, guard composition (class then
 * method, in declared order), @Public / @RequireModule / @RequirePermission /
 * @ApiTags. The owning controller class is captured separately so a route can
 * legitimately move between controllers without changing the frozen inventory.
 */

// Nest / Swagger metadata keys (mirrored here so the util has no runtime deps
// on internal constant modules beyond MODULE_METADATA).
const PATH_METADATA = 'path';
const METHOD_METADATA = 'method';
const VERSION_METADATA = '__version__';
const GUARDS_METADATA = '__guards__';
const API_TAGS_METADATA = 'swagger/apiUseTags';
const IS_PUBLIC_KEY = 'isPublic';
const REQUIRED_MODULE_KEY = 'requiredModule';
const REQUIRED_PERMISSION_KEY = 'requiredPermission';
const REQUIRED_ORG_STRUCTURE_PERMISSION_KEY = 'requiredOrgStructurePermission';
const REQUIRED_SYSTEM_ROLE_KEY = 'requiredSystemRole';
const MEMBERSHIP_ONLY_KEY = 'membershipOnly';
const SKIP_PROJECT_SCOPE_KEY = 'skipProjectScope';

const REQUEST_METHOD: Record<number, string> = {
  0: 'GET',
  1: 'POST',
  2: 'PUT',
  3: 'DELETE',
  4: 'PATCH',
  5: 'ALL',
  6: 'OPTIONS',
  7: 'HEAD',
  8: 'SEARCH',
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Ctor = new (...args: any[]) => any;

export interface RouteEntry {
  method: string;
  /** Full path incl. leading `/api` prefix, `v<version>` segment and controller path. */
  path: string;
  version: string;
  guards: string[];
  public: boolean;
  requireModule: string | null;
  requirePermission: string | null;
  requireSystemRole: string | null;
  membershipOnly: boolean;
  skipProjectScope: boolean;
  apiTags: string[];
  /** Owning controller — informational only, NOT part of the frozen contract. */
  controller: string;
}

function guardNames(target: object): string[] {
  const guards: unknown = Reflect.getMetadata(GUARDS_METADATA, target) ?? [];
  if (!Array.isArray(guards)) return [];
  return guards.map((g) => {
    if (typeof g === 'function') return g.name;
    // instance-based guard
    return (g as { constructor?: { name?: string } })?.constructor?.name ?? String(g);
  });
}

function versionToken(v: unknown): string {
  // Nest's VERSION_NEUTRAL is a Symbol; render it as a stable, readable marker.
  if (typeof v === 'symbol') return 'neutral';
  return String(v);
}

function versionOf(meta: unknown): string {
  if (meta == null) return '';
  if (Array.isArray(meta)) return meta.map(versionToken).join(',');
  return versionToken(meta);
}

function normalizePath(prefix: string, segment: string): string {
  const clean = (s: string) => s.replace(/^\/+|\/+$/g, '');
  const parts = [clean(prefix), clean(segment)].filter((p) => p.length > 0);
  return '/' + parts.join('/');
}

/**
 * @param controllers  the controller classes to inventory
 * @param globalPrefix e.g. 'api' (setGlobalPrefix)
 */
export function buildRouteInventory(controllers: Ctor[], globalPrefix = 'api'): RouteEntry[] {
  const scanner = new MetadataScanner();
  const entries: RouteEntry[] = [];

  for (const controller of controllers) {
    const proto = controller.prototype as object;
    const ctrlPath = versionOfPath(Reflect.getMetadata(PATH_METADATA, controller));
    const ctrlVersion = versionOf(Reflect.getMetadata(VERSION_METADATA, controller));
    const ctrlGuards = guardNames(controller);
    const ctrlTags: string[] =
      (Reflect.getMetadata(API_TAGS_METADATA, controller) as string[]) ?? [];

    const methodNames = scanner.getAllMethodNames(proto);
    for (const name of methodNames) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const handler = (proto as any)[name];
      const methodMeta = Reflect.getMetadata(METHOD_METADATA, handler);
      const pathMeta = Reflect.getMetadata(PATH_METADATA, handler);
      // Only decorated route handlers carry METHOD_METADATA + PATH_METADATA.
      if (methodMeta === undefined || pathMeta === undefined) continue;

      const method = REQUEST_METHOD[methodMeta as number] ?? String(methodMeta);
      const version = versionOf(Reflect.getMetadata(VERSION_METADATA, handler)) || ctrlVersion;
      // Version-neutral routes carry no `v<n>` URI segment (they match any/no version).
      const versionSeg = version && version !== 'neutral' ? `v${version}` : '';
      const fullPath = normalizePath(
        normalizePath(globalPrefix, versionSeg),
        normalizePath(ctrlPath, versionOfPath(pathMeta)),
      );

      const methodGuards = guardNames(handler);
      const isPublic =
        Boolean(Reflect.getMetadata(IS_PUBLIC_KEY, handler)) ||
        Boolean(Reflect.getMetadata(IS_PUBLIC_KEY, controller));
      const reqModule =
        (Reflect.getMetadata(REQUIRED_MODULE_KEY, handler) as string | undefined) ??
        (Reflect.getMetadata(REQUIRED_MODULE_KEY, controller) as string | undefined) ??
        null;
      const reqPermMeta =
        (Reflect.getMetadata(REQUIRED_PERMISSION_KEY, handler) as
          | { subject: string; action: string }
          | undefined) ?? null;
      const reqOrgPermMeta =
        (Reflect.getMetadata(REQUIRED_ORG_STRUCTURE_PERMISSION_KEY, handler) as
          | { subject: string; action: string }
          | undefined) ?? null;
      const reqPerm = reqPermMeta
        ? `${reqPermMeta.subject}:${reqPermMeta.action}`
        : reqOrgPermMeta
          ? `${reqOrgPermMeta.subject}:${reqOrgPermMeta.action}`
          : null;
      const reqSystemRole =
        (Reflect.getMetadata(REQUIRED_SYSTEM_ROLE_KEY, handler) as string | undefined) ??
        (Reflect.getMetadata(REQUIRED_SYSTEM_ROLE_KEY, controller) as string | undefined) ??
        null;
      const membershipOnly =
        Boolean(Reflect.getMetadata(MEMBERSHIP_ONLY_KEY, handler)) ||
        Boolean(Reflect.getMetadata(MEMBERSHIP_ONLY_KEY, controller));
      const skipProjectScope =
        Boolean(Reflect.getMetadata(SKIP_PROJECT_SCOPE_KEY, handler)) ||
        Boolean(Reflect.getMetadata(SKIP_PROJECT_SCOPE_KEY, controller));
      const methodTags: string[] =
        (Reflect.getMetadata(API_TAGS_METADATA, handler) as string[]) ?? [];

      entries.push({
        method,
        path: fullPath,
        version,
        // class guards first, then method guards — matches Nest execution order.
        guards: [...ctrlGuards, ...methodGuards],
        public: isPublic,
        requireModule: reqModule,
        requirePermission: reqPerm,
        requireSystemRole: reqSystemRole,
        membershipOnly,
        skipProjectScope,
        apiTags: methodTags.length ? methodTags : ctrlTags,
        controller: controller.name,
      });
    }
  }

  return entries;
}

/** Coerce a path metadata value (string | string[] | undefined) to a single string. */
function versionOfPath(meta: unknown): string {
  if (meta == null) return '';
  if (Array.isArray(meta)) return String(meta[0] ?? '');
  return String(meta);
}

/**
 * Stable, contract-only serialization of the inventory. The owning controller
 * is intentionally EXCLUDED so a route may move between controllers (P28 splits)
 * without changing the frozen snapshot. Sorted by (method, path, version).
 */
export function serializeInventory(entries: RouteEntry[]): string[] {
  return entries
    .map(
      (e) =>
        `${e.method} ${e.path} | v=${e.version} | guards=[${e.guards.join(',')}]` +
        ` | public=${e.public} | module=${e.requireModule ?? '-'}` +
        ` | perm=${e.requirePermission ?? '-'} | sys=${e.requireSystemRole ?? '-'}` +
        ` | membershipOnly=${e.membershipOnly} | skipScope=${e.skipProjectScope}` +
        ` | tags=[${[...e.apiTags].sort().join(',')}]`,
    )
    .sort((a, b) => a.localeCompare(b));
}

/** Read the controllers array declared on a Nest @Module class. */
export function controllersOf(moduleClass: Ctor): Ctor[] {
  return (Reflect.getMetadata(MODULE_METADATA.CONTROLLERS, moduleClass) as Ctor[]) ?? [];
}
