import {
  Controller,
  Get,
  Query,
  Inject,
  OnModuleInit,
  Post,
  Put,
  Body,
  Param,
  VERSION_NEUTRAL,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import { ClientGrpcProxy } from '@nestjs/microservices';
import { firstValueFrom, type Observable } from 'rxjs';
import { grpcBffCall, toNum } from './grpc-bff-call';
import { jsonToStruct, structToJson } from './grpc-struct';
import { decodeGrpcProject } from './project-grpc.codec';
import { ApiTags, ApiBearerAuth } from '@nestjs/swagger';
import { Public } from '../common/public.decorator';
import { PROJECT_TEMPLATES, type ProjectTemplate } from '@fairflow/shared';
import type { FastifyRequest, FastifyReply } from 'fastify';
import { GatewayOutboundMetadataService } from './gateway-outbound-metadata.service';
import { GatewayModuleGuard } from '../guards/gateway-module.guard';
import { ProjectAccessGuard } from '../guards/project-access.guard';
import { RequireModule } from '../guards/require-module.decorator';
import { RequirePermission } from '../guards/require-permission.decorator';
import {
  BadRequestException,
  ForbiddenException,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { NotificationStreamService } from './notification-stream.service';
import { assertSearchQueryRateLimit, resetSearchQueryRateLimiter } from './search-rate-limit';

type GrpcReq = FastifyRequest & { user?: { userId?: string } };

/**
 * Timestamps reach the BFF mappers in MIXED units: `grpcBffCall` rewrites the
 * known TS_KEYS (`created_at`, `updated_at`, …) from ms to SECONDS for the FE
 * `dayjs.unix` contract, while everything else (`sent_at`, `read_at`) stays in
 * ms. `toIso` assumed ms, so `date` (built from the already-downscaled
 * `created_at`) rendered as 1970-01-21 in the notification feed. Accept both:
 * anything below 1e11 is seconds.
 */
function tsToMs(ts: unknown): number {
  const n = toNum(ts);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return n < 1e11 ? n * 1000 : n;
}

function toIso(ts: unknown): string {
  const ms = tsToMs(ts);
  return ms > 0 ? new Date(ms).toISOString() : new Date().toISOString();
}

function parseJsonObject(input: unknown): Record<string, unknown> {
  if (typeof input !== 'string' || input.length === 0) return {};
  try {
    const parsed = JSON.parse(input);
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** int64 (proto) arrives as a Long/string; 0/absent means "no timestamp". */
function optIso(ts: unknown): string | null {
  const ms = tsToMs(ts);
  return ms > 0 ? new Date(ms).toISOString() : null;
}

const str = (v: unknown): string => (typeof v === 'string' ? v : '');

function notificationFe(n: Record<string, unknown>) {
  const data = parseJsonObject(n.data_json);
  return {
    id: String(n.id ?? ''),
    target: String(n.title ?? ''),
    description: String(n.body ?? ''),
    date: toIso(n.created_at),
    image: '',
    type: 0,
    // The canonical deep-link key written by the domain is `deepLink` — that is
    // what the email CTA reads (`notification.service.ts#buildCtaUrl`). The BFF
    // only ever read `path`, which nothing writes, so the in-app click handler
    // (NotificationDropdown) always fell back to «open the feed». Accept both.
    location: str(data.deepLink) || str(data.path),
    locationLabel: str(data.category_title),
    status: String(n.status ?? 'sent'),
    readed: Boolean(n.readed),
    // The domain already fills every field below (notification.service.ts
    // `toMessage`) and the FE `NotificationItem` declares category/severity/
    // projectId — they used to be dropped here, so the feed rendered untyped
    // rows (no category chip, no severity accent, no deep-link entity).
    category: String(n.category ?? ''),
    severity: String(n.severity ?? 'info'),
    eventType: String(n.event_type ?? ''),
    entityType: String(n.entity_type ?? ''),
    entityId: String(n.entity_id ?? ''),
    emailStatus: String(n.email_status ?? ''),
    projectId: String(n.project_id ?? ''),
    channels: Array.isArray(n.channels) ? n.channels.map(String) : [],
    readAt: optIso(n.read_at),
    sentAt: optIso(n.sent_at),
  };
}

type CategoryPrefWire = {
  category: string;
  in_app: boolean;
  email: boolean;
  escalate_offline: boolean;
};

/**
 * Category preferences travel as a `repeated CategoryPref` (proto + domain), but
 * the FE `NotificationPreferences.categories` is a `Record<category, CategoryPref>`
 * (NotificationSettings.tsx builds `categories[spec.category] = {in_app,email}`).
 * The BFF only accepted an ARRAY, so the FE map failed `Array.isArray` and the
 * whole `categories` field was dropped before the gRPC call — per-category channel
 * toggles were never persisted, silently. Accept BOTH shapes.
 */
function categoriesToWire(input: unknown): CategoryPrefWire[] | undefined {
  const row = (c: Record<string, unknown>, category?: string): CategoryPrefWire => ({
    category: String(category ?? c.category ?? ''),
    in_app: Boolean(c.in_app ?? c.inApp ?? true),
    email: Boolean(c.email ?? false),
    escalate_offline: Boolean(c.escalate_offline ?? c.escalateOffline ?? false),
  });
  if (Array.isArray(input)) return (input as Record<string, unknown>[]).map((c) => row(c));
  if (input && typeof input === 'object') {
    return Object.entries(input as Record<string, unknown>).map(([category, v]) =>
      row((v && typeof v === 'object' ? v : {}) as Record<string, unknown>, category),
    );
  }
  return undefined;
}

/**
 * Domain → FE preferences. The reverse of {@link categoriesToWire}: the FE indexes
 * `prefs.categories[spec.category]`, so an array response made every saved toggle
 * invisible (it always fell back to the catalog default).
 */
function preferencesFe(p: Record<string, unknown>) {
  const categories: Record<string, Omit<CategoryPrefWire, 'category'>> = {};
  for (const raw of Array.isArray(p.categories) ? (p.categories as unknown[]) : []) {
    const c = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
    const key = String(c.category ?? '');
    if (!key) continue;
    categories[key] = {
      in_app: Boolean(c.in_app),
      email: Boolean(c.email),
      escalate_offline: Boolean(c.escalate_offline),
    };
  }
  return {
    user_id: String(p.user_id ?? ''),
    email_mode: String(
      p.email_mode ?? (process.env.FAIRFLOW_EDITION === 'cloud' ? 'immediate' : 'off'),
    ),
    digest_time: (p.digest_time as string | null) ?? null,
    timezone: (p.timezone as string | null) ?? null,
    categories,
    quiet_hours: (p.quiet_hours as unknown) ?? null,
    updated_at: toNum(p.updated_at),
  };
}

// SEC-N-2: notification project-scoped routes require a non-empty X-Project-Id /
// projectId. No silent fallback to a shared 'default' project.
function requireProjectId(projectId?: string): string {
  const pid = (projectId ?? '').trim();
  if (!pid) {
    throw new BadRequestException({
      code: 'INVALID_ARGUMENT',
      message: 'X-Project-Id is required',
    });
  }
  return pid;
}

/**
 * Search routes are guarded by `ProjectAccessGuard`, which resolves the project as
 * `params.projectId ?? query.projectId ?? x-project-id`. The handlers must use the
 * SAME id, otherwise a caller that only sends the ambient header is authorized in
 * project P but the domain is asked about the literal project 'default' (and the
 * guard-resolved visibility scope belongs to P) → zero hits. This never widens
 * isolation: the header value is exactly what the guard already authorized.
 *
 * TODO-281/TODO-296 (fail-closed): there is NO third fallback. The old
 * `|| 'default'` tail stamped an unverified project id into TRUSTED outbound
 * metadata (`x-project-id`) — a caller that sent no project at all was queried
 * against the literal project `'default'`, which ProjectAccessGuard never checked
 * membership for. With `@RequirePermission('search', …)` on both routes the guard
 * now also rejects a missing project (PROJECT_ID_REQUIRED) — this throw is the
 * handler-level twin so the invariant holds even if the route were ever re-declared
 * without a permission decorator.
 */
export function resolveSearchProjectId(
  req: { headers?: Record<string, unknown> },
  projectId?: string,
): string {
  const fromQuery = (projectId ?? '').trim();
  if (fromQuery) return fromQuery;
  const hdr = req.headers?.['x-project-id'];
  const fromHeader = typeof hdr === 'string' ? hdr.trim() : '';
  if (fromHeader) return fromHeader;
  throw new BadRequestException({
    code: 'PROJECT_ID_REQUIRED',
    message: 'projectId is required (query param or x-project-id header)',
  });
}

/**
 * TODO-492 — the ONE reader of the per-project search settings.
 *
 * The settings round-trip (FE `SearchSettingsTab` → PUT/GET
 * `/projects/:id/modules/search/settings` → control `moduleConfigs[search].
 * personalSettings`) persisted values nobody applied: the domain hard-coded the
 * `minQueryChars=2` threshold and `perTypeLimit=5`, and the FE fell back to
 * `DEFAULT_SEARCH_SETTINGS`. Reading them on the FE is impossible for a rank-and-
 * file user (the GET is `project:manage`-gated), so the gateway is the reader: it
 * resolves the project's settings server-side and folds them into the gRPC request
 * (`per_type_limit`, `entity_types`) / the status response (`freshnessSlaMs`).
 *
 * Only NARROWING is applied: `indexableTypes` intersects the requested types (an
 * empty intersection short-circuits to an empty result instead of degrading to
 * "all types", which is how the domain reads an empty `entity_types`).
 */
export interface SearchModuleSettings {
  minQueryChars?: number;
  perTypeLimit?: number;
  indexableTypes?: string[];
  freshnessSlaMs?: number;
  /** TODO-492 (tail): purely CLIENT-side behaviour (⌘K/Ctrl+K registration) — the
   * gateway never acts on it, it only DELIVERS it, because the settings source
   * (`GET /projects/:id/modules/search/settings`) is `project:manage`-gated and a
   * rank-and-file user therefore cannot read their own project's value. */
  hotkeyEnabled?: boolean;
}

/** Module defaults for the client-facing settings read (`GET /search/settings`).
 * Mirrors `DEFAULT_SEARCH_SETTINGS` on the FE and the domain's own floors, so an
 * unconfigured project answers with concrete values instead of `undefined`s. */
export const SEARCH_CLIENT_SETTINGS_DEFAULTS = {
  minQueryChars: 2,
  perTypeLimit: 5,
  hotkeyEnabled: true,
} as const;

/** Best-effort settings cache: search runs per keystroke (debounced), we do not
 * want a control round-trip on every one. TTL mirrors the guard's policy cache. */
const SEARCH_SETTINGS_TTL_MS = parseInt(process.env.SEARCH_SETTINGS_CACHE_TTL_MS ?? '30000', 10);
const SEARCH_SETTINGS_CACHE = new Map<string, { expiresAt: number; value: SearchModuleSettings }>();

/** TODO-262: the viewer's departments for the `dept` scope preset, cached per
 * (user, project) with the same TTL rationale as the settings cache above — the
 * preset must not add a control round-trip to every debounced keystroke. */
const SEARCH_DEPTS_CACHE = new Map<string, { expiresAt: number; value: string[] }>();

/** Accepted values of the `scope` query param (TODO-262 / FR-SEARCH-140). */
export type SearchScopePreset = 'my' | 'dept' | 'all';

/** Unknown/absent → `undefined` = no narrowing (today's behaviour). A garbage
 * value must NOT 400 the search box; it degrades to the widest allowed read,
 * which is still the caller's resolved visibility scope. */
export function normalizeSearchScope(raw: unknown): SearchScopePreset | undefined {
  const v = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
  return v === 'my' || v === 'dept' || v === 'all' ? v : undefined;
}

/** Test hook — the cache is module-level, specs must not leak state into each other. */
export function resetSearchSettingsCache(): void {
  SEARCH_SETTINGS_CACHE.clear();
  SEARCH_DEPTS_CACHE.clear();
  resetSearchQueryRateLimiter();
}

/** Coerce a stored setting to a sane positive integer inside [1, max]; `undefined`
 * when the value is absent/garbage (control sanitizes types, not ranges). */
export function clampSetting(raw: unknown, max: number): number | undefined {
  const n = typeof raw === 'number' ? raw : typeof raw === 'string' ? Number(raw) : NaN;
  if (!Number.isFinite(n) || n <= 0) return undefined;
  return Math.min(Math.floor(n), max);
}

export function normalizeSearchSettings(raw: unknown): SearchModuleSettings {
  const src = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const types = Array.isArray(src.indexableTypes)
    ? src.indexableTypes.filter((t): t is string => typeof t === 'string' && t.trim().length > 0)
    : undefined;
  return {
    minQueryChars: clampSetting(src.minQueryChars, 32),
    perTypeLimit: clampSetting(src.perTypeLimit, 100),
    indexableTypes: types && types.length ? types : undefined,
    freshnessSlaMs: clampSetting(src.freshnessSlaMs, 24 * 60 * 60 * 1000),
    // Strict boolean only: control's sanitizeSettings already drops wrong types,
    // and coercing e.g. the string 'false' to `true` would silently re-enable a
    // hotkey the admin turned off.
    hotkeyEnabled: typeof src.hotkeyEnabled === 'boolean' ? src.hotkeyEnabled : undefined,
  };
}

/** The `/search/query` empty answer (same shape the mapper below produces), used
 * when the gateway short-circuits a query before calling the domain. */
export const EMPTY_SEARCH_RESPONSE = () => ({
  groups: [] as Array<{ entity_type: string; type_total: number; list: unknown[] }>,
  total: 0,
  total_by_type: {} as Record<string, number>,
  // TODO-261: nothing was queried → there is no next page to offer.
  has_more: false,
});

@Controller({ path: '', version: VERSION_NEUTRAL })
export class CommonBffController implements OnModuleInit {
  private readonly logger = new Logger(CommonBffController.name);
  private notification!: Record<string, (x: unknown, m?: unknown) => unknown>;
  private searchService!: Record<string, (x: unknown, m?: unknown) => unknown>;
  private audit!: Record<string, (x: unknown, m?: unknown) => unknown>;

  private controlProject!: {
    resolveRecordVisibility: (
      x: { project_id: string; user_id: string; resource: string },
      m?: unknown,
    ) => Observable<{ allowed?: boolean }>;
    getProject: (x: { id: string }, m?: unknown) => unknown;
    updateProject: (x: unknown, m?: unknown) => unknown;
    setModulePersonalSettings: (x: unknown, m?: unknown) => unknown;
    getModulePersonalSettings: (x: unknown, m?: unknown) => unknown;
  };

  /** TODO-262: control's PDP projection — the ONLY trusted source of the viewer's
   * departments for the `dept` scope preset (never the client body). */
  private controlRoles!: {
    resolvePermissionProjection?: (
      x: { project_id: string; user_id: string },
      m?: unknown,
    ) => unknown;
  };

  constructor(
    @Inject('NOTIFICATION_GRPC') private notificationClient: ClientGrpcProxy,
    @Inject('SEARCH_GRPC') private searchClient: ClientGrpcProxy,
    @Inject('AUDIT_GRPC') private auditClient: ClientGrpcProxy,
    @Inject('CONTROL_GRPC') private controlClient: ClientGrpcProxy,
    private readonly outboundMeta: GatewayOutboundMetadataService,
    private readonly stream: NotificationStreamService,
  ) {}

  onModuleInit() {
    this.notification = this.notificationClient.getService('NotificationGrpc');
    this.searchService = this.searchClient.getService('SearchGrpc');
    this.audit = this.auditClient.getService('AuditGrpc');
    this.controlProject = this.controlClient.getService('ProjectGrpc');
    this.controlRoles = this.controlClient.getService('RoleGrpc') ?? {};
  }

  @Get('notification/count')
  @ApiTags('Notifications')
  @ApiBearerAuth()
  @UseGuards(GatewayModuleGuard, ProjectAccessGuard)
  @RequireModule('notifications')
  @RequirePermission('notifications', 'read')
  async nCount(
    @Req() req: GrpcReq,
    @Query('projectId') projectId?: string,
    // OQ-N-1: accept both camelCase (AS-IS) and snake_case (TZ §6.1).
    @Query('unreadOnly') unreadOnly?: string,
    @Query('unread_only') unreadOnlySnake?: string,
    @Query('scope') scope?: string,
  ) {
    const pid = requireProjectId(projectId);
    const unread = unreadOnlySnake ?? unreadOnly;
    const md = this.outboundMeta.build(req, { projectId: pid });
    const r = (await grpcBffCall(
      this.notification.getCount(
        {
          project_id: pid,
          user_id: req.user?.userId ?? '',
          unread_only: unread !== 'false',
          scope: scope ?? '',
        },
        md,
      ) as never,
    )) as { count?: unknown };
    // proto int64 → @grpc/proto-loader returns a Long object; coerce to a plain
    // number so the FE bell badge (`countData.count`) is numeric, not `{low,high}`.
    return { count: Number(r.count ?? 0) };
  }

  @Get('notification/list')
  @ApiTags('Notifications')
  @ApiBearerAuth()
  @UseGuards(GatewayModuleGuard, ProjectAccessGuard)
  @RequireModule('notifications')
  @RequirePermission('notifications', 'read')
  async nList(
    @Req() req: GrpcReq,
    @Query('projectId') projectId?: string,
    @Query('pageIndex') pageIndex?: string,
    @Query('page_index') pageIndexSnake?: string,
    @Query('pageSize') pageSize?: string,
    @Query('page_size') pageSizeSnake?: string,
    @Query('unreadOnly') unreadOnly?: string,
    @Query('unread_only') unreadOnlySnake?: string,
    @Query('category') category?: string,
    @Query('scope') scope?: string,
  ) {
    const pid = requireProjectId(projectId);
    const md = this.outboundMeta.build(req, { projectId: pid });
    const r = (await grpcBffCall(
      this.notification.listNotifications(
        {
          project_id: pid,
          user_id: req.user?.userId ?? '',
          page_index: parseInt(pageIndexSnake ?? pageIndex ?? '0', 10),
          page_size: parseInt(pageSizeSnake ?? pageSize ?? '25', 10),
          unread_only: (unreadOnlySnake ?? unreadOnly) === 'true',
          category: category ?? '',
          scope: scope ?? '',
        },
        md,
      ) as never,
    )) as {
      list?: Record<string, unknown>[];
      total?: unknown;
    };
    // Contract §3.2 / FE `NotificationListResponse` = { list, total }. This route
    // used to return a BARE ARRAY, so `useNotifications` (`listData?.list ?? []`,
    // the bell + feed + optimistic markRead) always saw an empty feed and total 0
    // even with a populated domain response. `total` is int64 → Long, coerce.
    return {
      list: (Array.isArray(r.list) ? r.list : []).map(notificationFe),
      total: toNum(r.total),
    };
  }

  @Put('notification/read-all')
  @ApiTags('Notifications')
  @ApiBearerAuth()
  @UseGuards(GatewayModuleGuard, ProjectAccessGuard)
  @RequireModule('notifications')
  @RequirePermission('notifications', 'read')
  async markAllRead(
    @Req() req: GrpcReq,
    @Query('projectId') projectId?: string,
    @Query('scope') scope?: string,
    @Body() body?: { scope?: string },
  ) {
    const pid = requireProjectId(projectId);
    const md = this.outboundMeta.build(req, { projectId: pid });
    const r = (await grpcBffCall(
      this.notification.markAllRead(
        { project_id: pid, user_id: req.user?.userId ?? '', scope: scope ?? body?.scope ?? '' },
        md,
      ) as never,
    )) as { updated?: unknown; unread?: unknown };
    // Real-time badge reset (contract §3.4 / FR-MNOT-9) so other tabs update ≤ 3s.
    this.stream.publishBadge(req.user?.userId ?? '', { type: 'badge', projectId: pid, unread: 0 });
    // proto int64 → Long object; coerce so the FE gets plain numbers (§3.4).
    return { updated: Number(r.updated ?? 0), unread: Number(r.unread ?? 0) };
  }

  @Put('notification/:id/read')
  @ApiTags('Notifications')
  @ApiBearerAuth()
  @UseGuards(GatewayModuleGuard, ProjectAccessGuard)
  @RequireModule('notifications')
  @RequirePermission('notifications', 'read')
  async markRead(
    @Req() req: GrpcReq,
    @Param('id') id: string,
    @Query('projectId') projectId?: string,
  ) {
    const pid = requireProjectId(projectId);
    const md = this.outboundMeta.build(req, { projectId: pid });
    const r = (await grpcBffCall(
      this.notification.markRead(
        {
          project_id: pid,
          user_id: req.user?.userId ?? '',
          notification_id: id,
        },
        md,
      ) as never,
    )) as Record<string, unknown>;
    // Real-time badge refresh (contract §3.3 / FR-MNOT-9): nudge other tabs to
    // re-fetch the unread count without polling (no unread value → client re-reads).
    this.stream.publishBadge(req.user?.userId ?? '', { type: 'badge', projectId: pid });
    return notificationFe(r);
  }

  @Get('notification/catalog')
  @ApiTags('Notifications')
  @ApiBearerAuth()
  @UseGuards(GatewayModuleGuard, ProjectAccessGuard)
  @RequireModule('notifications')
  @RequirePermission('notifications', 'read')
  async nCatalog(@Req() req: GrpcReq, @Query('projectId') projectId?: string) {
    const pid = requireProjectId(projectId);
    const md = this.outboundMeta.build(req, { projectId: pid });
    return grpcBffCall(this.notification.getCatalog({ project_id: pid }, md) as never);
  }

  // contract §3.5 (FR-MNOT-9, D-3): real-time badge push over SSE. JWT is verified by
  // the global guard at connect; ProjectAccessGuard enforces membership + module +
  // notifications:read for the connecting project. The connection then streams `badge`
  // events for the user, FILTERED to the connection's project (SEC-N-4): a signal for
  // another project is dropped, and membership is periodically re-validated so a
  // revoked user / project-removal stops receiving badges within one re-check window.
  @Get('notification/stream')
  @ApiTags('Notifications')
  @ApiBearerAuth()
  @UseGuards(GatewayModuleGuard, ProjectAccessGuard)
  @RequireModule('notifications')
  @RequirePermission('notifications', 'read')
  async nStream(
    @Req() req: GrpcReq,
    @Res() reply: FastifyReply,
    @Query('projectId') projectId?: string,
  ) {
    const pid = requireProjectId(projectId);
    const userId = req.user?.userId ?? '';
    const raw = reply.raw;

    raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    // Initial comment flushes headers and opens the stream for the client.
    raw.write(': connected\n\n');

    const write = (event: string, data: unknown) => {
      if (raw.writableEnded) return;
      raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };

    // SEC-N-4: only push badge signals for the project this connection is scoped to.
    const unsubscribe = this.stream.subscribe(userId, (signal) => {
      if (signal.projectId === pid) write('badge', signal);
    });

    // Keep-alive ping (contract §3.5) so proxies don't drop an idle connection.
    const PING_MS = Number.parseInt(process.env.GATEWAY_SSE_PING_MS ?? '25000', 10);
    const ping = setInterval(() => write('ping', { t: Date.now() }), PING_MS);

    // SEC-N-4: bound connection TTL + periodically re-validate active membership.
    // A revoked JWT / project removal stops the stream at the next re-check.
    const REVALIDATE_MS = Number.parseInt(process.env.GATEWAY_SSE_REVALIDATE_MS ?? '60000', 10);
    const MAX_TTL_MS = Number.parseInt(process.env.GATEWAY_SSE_MAX_TTL_MS ?? '900000', 10);
    const startedAt = Date.now();
    let closed = false;
    const close = () => {
      if (closed) return;
      closed = true;
      clearInterval(ping);
      clearInterval(revalidate);
      unsubscribe();
      if (!raw.writableEnded) raw.end();
    };
    const revalidate = setInterval(() => {
      void (async () => {
        if (Date.now() - startedAt >= MAX_TTL_MS) {
          write('expired', { reason: 'ttl' });
          close();
          return;
        }
        try {
          const md = this.outboundMeta.build(req, { projectId: pid });
          const res = await firstValueFrom(
            this.controlProject.resolveRecordVisibility(
              { project_id: pid, user_id: userId, resource: '' },
              md,
            ),
          );
          if (res?.allowed !== true) {
            write('revoked', { projectId: pid });
            close();
          }
        } catch {
          // Fail-closed: cannot confirm membership → end the stream (client polls).
          write('revoked', { projectId: pid });
          close();
        }
      })();
    }, REVALIDATE_MS);

    req.raw.on('close', close);
    raw.on('error', close);
  }

  // SEC-N-5: preferences are per-user (project-less). user_id is resolved in the
  // domain from metadata x-user-id; never from query/body.
  @Get('notification/preferences')
  @ApiTags('Notifications')
  @ApiBearerAuth()
  async getPreferences(@Req() req: GrpcReq) {
    const md = this.outboundMeta.build(req);
    const r = (await grpcBffCall(
      this.notification.getPreferences({ user_id: req.user?.userId ?? '' }, md) as never,
    )) as Record<string, unknown>;
    return preferencesFe(r);
  }

  @Put('notification/preferences')
  @ApiTags('Notifications')
  @ApiBearerAuth()
  async updatePreferences(@Req() req: GrpcReq, @Body() body: Record<string, unknown>) {
    const md = this.outboundMeta.build(req);
    // Accepts both the FE record map and a plain array (see categoriesToWire).
    const categories = categoriesToWire(body.categories);
    const qh = body.quiet_hours ?? body.quietHours;
    const quietHours =
      qh && typeof qh === 'object'
        ? {
            from: String((qh as Record<string, unknown>).from ?? ''),
            to: String((qh as Record<string, unknown>).to ?? ''),
            tz: String((qh as Record<string, unknown>).tz ?? ''),
          }
        : undefined;
    const r = (await grpcBffCall(
      this.notification.updatePreferences(
        {
          // SEC-N-5: user_id intentionally NOT taken from body.
          email_mode: body.email_mode ?? body.emailMode,
          digest_time: body.digest_time ?? body.digestTime,
          timezone: body.timezone,
          categories,
          quiet_hours: quietHours,
        },
        md,
      ) as never,
      'write',
    )) as Record<string, unknown>;
    // The FE writes this straight back into its SWR cache (`refetchPrefs(saved,
    // false)`), so the echo must use the same FE shape as the GET.
    return preferencesFe(r);
  }

  // SEC-N-3: direct send is integration-only. Requires notifications.integration:invoke
  // (a capability only service-tokens / privileged roles hold), not end-user read.
  @Post('notification/send')
  @ApiTags('Notifications')
  @ApiBearerAuth()
  @UseGuards(GatewayModuleGuard, ProjectAccessGuard)
  @RequireModule('notifications')
  @RequirePermission('notifications.integration', 'invoke')
  async sendNotification(
    @Req() req: GrpcReq,
    @Body() body: Record<string, unknown>,
    @Query('projectId') projectId?: string,
  ) {
    // SEC-ISO-1 (TODO-001): projectId comes only from the guard-enforced sources
    // (query param / x-project-id header). A body-supplied projectId must never
    // override the project the caller was authorized in — mismatch → 403.
    const headerPid = req.headers?.['x-project-id'];
    const pid = requireProjectId(
      (projectId ?? '').trim() || (typeof headerPid === 'string' ? headerPid.trim() : ''),
    );
    const claimed = body.projectId == null ? '' : String(body.projectId).trim();
    if (claimed && claimed !== pid) {
      throw new ForbiddenException({
        code: 'PROJECT_ACCESS_DENIED',
        message: 'projectId in the request body does not match the authorized project',
      });
    }
    const idemHeader = req.headers?.['idempotency-key'];
    const idempotencyKey =
      typeof idemHeader === 'string'
        ? idemHeader.trim()
        : Array.isArray(idemHeader) && typeof idemHeader[0] === 'string'
          ? idemHeader[0].trim()
          : typeof body.idempotencyKey === 'string'
            ? body.idempotencyKey.trim()
            : '';
    const md = this.outboundMeta.build(req, { projectId: pid });
    const r = (await grpcBffCall(
      this.notification.send(
        {
          project_id: pid,
          user_id: body.userId ?? req.user?.userId ?? '',
          channel: body.channel ?? 'in_app',
          title: body.title,
          body: body.body,
          data_json: body.data && typeof body.data === 'object' ? JSON.stringify(body.data) : '{}',
          category: body.category ?? '',
          event_type:
            typeof body.eventType === 'string'
              ? body.eventType
              : typeof body.event_type === 'string'
                ? body.event_type
                : '',
          idempotency_key: idempotencyKey,
          // SEC-N-9: recipient email is resolved in the domain from the trusted
          // user directory by user_id — never accept email_to from the body.
          email_to: '',
        },
        md,
      ) as never,
      'write',
    )) as Record<string, unknown>;
    return notificationFe(r);
  }

  /**
   * TODO-492: per-project search settings, read server-side (see
   * {@link normalizeSearchSettings}). Best-effort — a control outage or an
   * unconfigured project degrades to `{}` (module defaults), never to an error:
   * search must keep working when the settings source is unavailable.
   */
  private async searchSettings(projectId: string, md: unknown): Promise<SearchModuleSettings> {
    const cached = SEARCH_SETTINGS_CACHE.get(projectId);
    if (cached && cached.expiresAt > Date.now()) return cached.value;
    const value = await this.fetchSearchSettings(projectId, md);
    if (SEARCH_SETTINGS_TTL_MS > 0) {
      SEARCH_SETTINGS_CACHE.set(projectId, {
        value,
        expiresAt: Date.now() + SEARCH_SETTINGS_TTL_MS,
      });
    }
    return value;
  }

  private async fetchSearchSettings(projectId: string, md: unknown): Promise<SearchModuleSettings> {
    try {
      const project = decodeGrpcProject(
        (await grpcBffCall(
          this.controlProject.getProject({ id: projectId }, md) as never,
        )) as Record<string, unknown>,
      ) as {
        module_configs?: Array<{
          module_id?: string;
          personal_settings?: Record<string, unknown>;
        }>;
      };
      const cfg = (project?.module_configs ?? []).find((c) => c.module_id === 'search');
      return normalizeSearchSettings(cfg?.personal_settings);
    } catch {
      return {};
    }
  }

  /**
   * TODO-262: departments of the CURRENT viewer in this project, from control's
   * `RoleGrpc.ResolvePermissionProjection` (the same projection the FE sidebar
   * gating reads). Cached per (user, project) with the search-settings TTL, so
   * the `dept` preset does not add a control round-trip to every keystroke.
   *
   * Best-effort in the SAFE direction only: on any failure we return `[]`, which
   * makes the domain match nothing. Returning "no narrowing" instead would turn a
   * control outage into a silent widening of the result set.
   */
  private async viewerDepartments(projectId: string, req: GrpcReq, md: unknown): Promise<string[]> {
    const userId = req.user?.userId ?? '';
    if (!userId) return [];
    const key = `${userId}::${projectId}`;
    const cached = SEARCH_DEPTS_CACHE.get(key);
    if (cached && cached.expiresAt > Date.now()) return cached.value;
    let value: string[] = [];
    let resolved = false;
    try {
      const rpc = this.controlRoles?.resolvePermissionProjection;
      if (typeof rpc === 'function') {
        const res = (await grpcBffCall(
          rpc.call(this.controlRoles, { project_id: projectId, user_id: userId }, md) as never,
        )) as {
          visibility_scope?: { department_ids?: string[]; departmentIds?: string[] };
          visibilityScope?: { department_ids?: string[]; departmentIds?: string[] };
        };
        const vs = res?.visibility_scope ?? res?.visibilityScope ?? {};
        const raw = vs.department_ids ?? vs.departmentIds ?? [];
        value = Array.isArray(raw) ? raw.filter((d) => typeof d === 'string' && d !== '') : [];
        resolved = true;
      }
    } catch {
      value = [];
    }
    // Only a real answer is cached: caching a transport failure would freeze the
    // preset at "empty" for the whole TTL after a single control hiccup.
    if (resolved && SEARCH_SETTINGS_TTL_MS > 0) {
      SEARCH_DEPTS_CACHE.set(key, { value, expiresAt: Date.now() + SEARCH_SETTINGS_TTL_MS });
    }
    return value;
  }

  @Get('search/query')
  @ApiTags('Search')
  @ApiBearerAuth()
  @RequirePermission('search', 'read')
  // ProjectAccessGuard is REQUIRED, not optional: it resolves the caller's
  // record-visibility scope into req.__visibilityScope AND the project's enabled
  // modules into req.__enabledModules, which the outbound metadata propagates as
  // x-visibility-scope / x-enabled-modules. Without it the search domain receives
  // no scope and buildVisibilityFilter() fail-closes to DENY_ALL — so every query
  // returned 0 hits ("Ничего не найдено") even with a populated index.
  //
  // T-018: search is a CROSS-CUTTING capability, NOT an opt-in business module —
  // no project enables the `search` module by default, so `@RequireModule('search')`
  // made EVERY query 403 `MODULE_DISABLED` ("поиск ничего не находит"). The gate is
  // dropped here: the read is still scoped to the caller's visibility AND narrowed
  // to the project's enabled entity types inside the domain (effectiveTypes ∩
  // x-enabled-modules, FR-MSRCH-11), so a project with no searchable module enabled
  // yields an empty result — never a hard 403. ProjectAccessGuard still runs so the
  // scope/enabled-modules metadata is populated. Reindex stays module+manage gated.
  @UseGuards(ProjectAccessGuard)
  // TODO-088: `search:read` was enforced ONLY on the FE (a UX gate, not security) —
  // the route itself accepted any project member. The catalog pair already exists
  // (module-registry `{ subject: 'search', actions: ['read','manage'] }`), so gate
  // the PEP on it: every project role (incl. viewer) has `read`, so no legitimate
  // caller loses access, but a project-wide DENY policy on `search:read` now
  // actually blocks the route. Deliberately NO @RequireModule('search') — see the
  // T-018 note above. Side effect (by design): with a permission declared,
  // ProjectAccessGuard fail-closes a request that carries no projectId at all
  // (PROJECT_ID_REQUIRED) instead of waving it through — TODO-281.
  @RequirePermission('search', 'read')
  async search(
    @Req() req: GrpcReq,
    @Query('query') query: string,
    @Query('projectId') projectId?: string,
    @Query('pageIndex') pageIndex?: string,
    @Query('pageSize') pageSize?: string,
    @Query('entityTypes') entityTypes?: string,
    @Query('perTypeLimit') perTypeLimit?: string,
    @Query('groupBy') groupBy?: string,
    // TODO-262 / FR-SEARCH-140: the UI scope preset «Мои / Мой отдел / Все
    // доступные». Narrowing only — see `scopeDepartmentIds` and the domain's
    // buildBaseFilter; an absent/unknown value keeps the pre-TODO-262 behaviour.
    @Query('scope') scope?: string,
  ) {
    // NOTE: projectId comes from x-project-id metadata in the domain (trusted);
    // the query param is only a hint and never widens isolation (contract §1).
    // ProjectAccessGuard resolves the project as `query.projectId ?? x-project-id`
    // — mirror that here. Without the header fallback a caller that only sends the
    // ambient X-Project-Id header (the host header search bar, CommonService
    // `apiGetSearchResult`) was authorized against its real project but queried the
    // literal project 'default' → always 0 hits. No widening: the guard already
    // authorized exactly this id.
    const pid = resolveSearchProjectId(req, projectId);
    assertSearchQueryRateLimit(req, pid);
    const md = this.outboundMeta.build(req, { projectId: pid });

    // TODO-492: apply the project's saved search settings (the gateway is their
    // only reader — the FE cannot read them, the GET is project:manage-gated).
    const settings = await this.searchSettings(pid, md);
    const requestedTypes = entityTypes
      ? entityTypes
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean)
      : [];
    const allowedTypes = settings.indexableTypes;
    let effectiveTypes = requestedTypes;
    if (allowedTypes?.length) {
      effectiveTypes = requestedTypes.length
        ? requestedTypes.filter((t) => allowedTypes.includes(t))
        : allowedTypes;
      // Requested ∩ indexable = ∅ → the caller asked for a type this project does
      // not index. Sending `[]` downstream would mean "no restriction" in the
      // domain (effectiveTypes() treats an empty list as ALL types), i.e. widening
      // — return the empty result here instead.
      if (!effectiveTypes.length) return EMPTY_SEARCH_RESPONSE();
    }
    // minQueryChars: enforced before the domain call AND passed downstream so a
    // direct gRPC caller cannot bypass a raised project threshold (TODO-492).
    const minQueryChars = settings.minQueryChars ?? SEARCH_CLIENT_SETTINGS_DEFAULTS.minQueryChars;
    if (minQueryChars > 0 && (query ?? '').trim().length < minQueryChars) {
      return EMPTY_SEARCH_RESPONSE();
    }
    // perTypeLimit: the FE always sends its own constant, so an "only when absent"
    // rule would leave the setting dead. An EXPLICIT type filter means the paged
    // single-type results screen, where the client value IS the page size and must
    // win; otherwise (the grouped overlay) the project setting wins over the FE
    // default hint.
    const clientPerTypeLimit = perTypeLimit ? parseInt(perTypeLimit, 10) : 0;
    const perTypeLimitValue = requestedTypes.length
      ? clientPerTypeLimit || settings.perTypeLimit || 0
      : settings.perTypeLimit || clientPerTypeLimit || 0;

    // TODO-262: the `dept` preset needs the viewer's departments, and the ONLY
    // trusted source is control's PDP projection — the client never states them.
    // Resolution failure/no department is NOT silently downgraded to "no filter"
    // (that would widen what the user asked to narrow): the domain receives an
    // empty list and matches nothing, which is what «мой отдел» means for a user
    // who has no department.
    const ownerScope = normalizeSearchScope(scope);
    const scopeDepartmentIds =
      ownerScope === 'dept' ? await this.viewerDepartments(pid, req, md) : [];

    const r = (await grpcBffCall(
      this.searchService.search(
        {
          project_id: pid,
          query: query ?? '',
          page_index: parseInt(pageIndex ?? '0', 10),
          page_size: parseInt(pageSize ?? '25', 10),
          entity_types: effectiveTypes,
          per_type_limit: perTypeLimitValue,
          group_by: groupBy ?? '',
          owner_scope: ownerScope ?? '',
          scope_department_ids: scopeDepartmentIds,
          min_query_chars: minQueryChars,
        },
        md,
      ) as never,
    )) as {
      groups?: Array<{
        entity_type: string;
        list?: Record<string, unknown>[];
        type_total?: number;
      }>;
      total?: number;
      total_by_type?: Record<string, number>;
      total_by_owner?: Record<string, number>;
      has_more?: boolean;
    };
    // proto int64 fields (total, type_total, updated_at, map values) arrive as
    // @grpc/proto-loader Long objects ({low,high}); coerce to plain numbers so the
    // FE comparisons (`data.total === 0`, `type_total - list.length`) work and don't
    // render `[object Object]`. Mirrors the chat/search-status BFF coercion above.
    const numMap = (m?: Record<string, number>): Record<string, number> => {
      const out: Record<string, number> = {};
      for (const [k, v] of Object.entries(m ?? {})) out[k] = Number(v ?? 0);
      return out;
    };
    // Contract §3.1 response shape: typed groups + aggregate counts. Legacy
    // category labels (nav/account/project) are dropped — search is now CRM
    // cross-entity (FR-MSRCH-2). FE (WM3-search-fe) renders groups by entity_type.
    const groups = Array.isArray(r.groups) ? r.groups : [];
    return {
      groups: groups.map((g) => ({
        entity_type: g.entity_type,
        type_total: Number(g.type_total ?? 0),
        list: (Array.isArray(g.list) ? g.list : []).map((h) => ({
          ...h,
          updated_at: Number((h as { updated_at?: number }).updated_at ?? 0),
        })),
      })),
      total: Number(r.total ?? 0),
      total_by_type: numMap(r.total_by_type),
      // TODO-261: the domain states whether a next page exists — it is the only
      // side that knows both the per-type totals and the per-type page size this
      // route resolved above (`perTypeLimitValue`, which may come from the project
      // settings rather than the client's pageSize). Passed through so the results
      // page can enable «Вперёд» honestly instead of guessing from `total`.
      has_more: Boolean(r.has_more),
      ...(r.total_by_owner ? { total_by_owner: numMap(r.total_by_owner) } : {}),
    };
  }

  /**
   * TODO-492 (tail) — the delivery channel for the settings that are the CLIENT's
   * to apply.
   *
   * Four of the five saved fields are applied server-side (see `search()` /
   * `searchStatus()`), but `hotkeyEnabled` describes browser behaviour the gateway
   * cannot enforce: the ⌘K/Ctrl+K listener lives in the host-shell search overlay
   * (`host/src/components/template/Search.tsx`, TODO-258). It stayed
   * write-only ("настройка есть, до пользователя не доходит") because the only read
   * of the saved values, `GET /projects/:id/modules/search/settings`, is
   * `project:manage`-gated — an ordinary member gets 403 and falls back to
   * `DEFAULT_SEARCH_SETTINGS`, i.e. the admin's «выключить хоткей» was ignored for
   * exactly the users it was set for.
   *
   * This route is the member-readable projection of the same config: the SAME
   * `search:read` gate as `/search/query` (whoever may search may learn how the
   * search box should behave), no index internals (those stay in the
   * `search:manage` `/search/status`), and defaults filled in so the FE gets
   * concrete values. Read-only — writes keep going through control.
   */
  @Get('search/settings')
  @ApiTags('Search')
  @ApiBearerAuth()
  // Same guard/gate pair as /search/query (see the notes there): the project is
  // resolved as `query.projectId ?? x-project-id`, and no @RequireModule('search')
  // — search is cross-cutting, not an opt-in module.
  @UseGuards(ProjectAccessGuard)
  @RequirePermission('search', 'read')
  async searchClientSettings(@Req() req: GrpcReq, @Query('projectId') projectId?: string) {
    const pid = resolveSearchProjectId(req, projectId);
    const md = this.outboundMeta.build(req, { projectId: pid });
    // Best-effort like every other reader: a control outage degrades to module
    // defaults (working hotkey, threshold 2), never to an error in the search box.
    const s = await this.searchSettings(pid, md);
    return {
      minQueryChars: s.minQueryChars ?? SEARCH_CLIENT_SETTINGS_DEFAULTS.minQueryChars,
      perTypeLimit: s.perTypeLimit ?? SEARCH_CLIENT_SETTINGS_DEFAULTS.perTypeLimit,
      hotkeyEnabled: s.hotkeyEnabled ?? SEARCH_CLIENT_SETTINGS_DEFAULTS.hotkeyEnabled,
      // `[]` = "the project did not restrict the set" (same meaning the query route
      // gives an absent value) — NOT "nothing is searchable".
      indexableTypes: s.indexableTypes ?? [],
      ...(s.freshnessSlaMs ? { freshnessSlaMs: s.freshnessSlaMs } : {}),
    };
  }

  @Get('search/status')
  @ApiTags('Search')
  @ApiBearerAuth()
  @RequirePermission('search', 'manage')
  // Resolve project membership/role (and scope) like every project-scoped route.
  // T-018: like search/query, status is not gated on the (never-enabled) `search`
  // module. FR-SEARCH-210 (TODO-088): freshness/indexed-count is an admin
  // observability surface — gated `search:manage` (flat matrix: owner/admin).
  @UseGuards(ProjectAccessGuard)
  // TODO-088: index freshness / lag / dead-letter counters are an ADMIN
  // observability read — the only caller is the project-settings tab
  // (`SearchSettingsTab` → `IndexStatusSection`), which sits next to the reindex
  // button. Gate it with the same catalog pair as reindex (`search:manage`, i.e.
  // owner/admin) so index internals are not readable by every project member.
  @RequirePermission('search', 'manage')
  async searchStatus(@Req() req: GrpcReq, @Query('projectId') projectId?: string) {
    const pid = resolveSearchProjectId(req, projectId);
    const md = this.outboundMeta.build(req, { projectId: pid });
    const r = (await grpcBffCall(
      this.searchService.status({ project_id: pid }, md) as never,
    )) as Record<string, unknown>;
    // TODO-492: `freshnessSlaMs` is a per-project setting; the domain only knows the
    // deployment-wide env default (SEARCH_FRESHNESS_SLA_MS). The saved value wins so
    // the FE's «индекс отстаёт» banner is judged against the project's own SLA.
    const settings = await this.searchSettings(pid, md);
    return {
      lastEventProcessedAt: Number(r.last_event_processed_at ?? 0),
      lagMs: Number(r.lag_ms ?? 0),
      indexedCount: Number(r.indexed_count ?? 0),
      freshnessSlaMs: settings.freshnessSlaMs ?? Number(r.freshness_sla_ms ?? 0),
      deadLetterCount: Number(r.dead_letter_count ?? 0),
    };
  }

  @Post('search/reindex')
  @ApiTags('Search')
  @ApiBearerAuth()
  // T-018 (completed here): search is a CROSS-CUTTING capability, not an opt-in
  // business module — no project enables `search` (control DEMO_SHOWCASE_MODULES,
  // module-registry `locked:false`), so `@RequireModule('search')` made reindex a
  // permanent 403 MODULE_DISABLED. query/settings/status already dropped that gate;
  // reindex kept it and was the ONE search route still unreachable — while the
  // project-settings tab that hosts the «Переиндексировать» button IS reachable
  // (host `CROSS_CUTTING_SETTINGS_MODULES`), i.e. a button whose backend always
  // refused. Manual reindex is also the operator's remedy for a stale/incomplete
  // index (TODO-263), so the remedy itself was blocked. The privileged nature of
  // the route is carried by `search:manage` below (owner/admin), NOT by module
  // enablement — same reasoning as `/search/status`, which is `manage`-gated and
  // module-free. GatewayModuleGuard is dropped with the decorator: without
  // @RequireModule it short-circuits to `true`, and ProjectAccessGuard is what
  // populates __enabledModules / __visibilityScope for the outbound metadata.
  @UseGuards(ProjectAccessGuard)
  // U5: reindex is a privileged, project-wide rebuild — gate it with the same
  // PEP the catalog already defines for search (subject 'search', action 'manage',
  // module-registry.ts). Read-path search/query is 'read'-gated (TODO-088); only
  // reindex requires 'manage'.
  @RequirePermission('search', 'manage')
  async reindex(
    @Req() req: GrpcReq,
    @Query('projectId') projectId: string,
    @Query('entityTypes') entityTypes?: string,
  ) {
    // Same resolution as query/status (TODO-281): the guard authorized
    // `query.projectId ?? x-project-id`, so a caller that only sent the ambient
    // header must rebuild THAT project instead of asking the domain to rebuild
    // project '' (INVALID_ARGUMENT). No widening, and no 'default' fallback.
    const pid = resolveSearchProjectId(req, projectId);
    // NOTE (TODO-491): the client's `Idempotency-Key` header already travels to the
    // domain as gRPC metadata `idempotency-key` (buildGatewayOutboundMetadata), and
    // a domain-side lock rejecting a concurrent rebuild with gRPC ABORTED /
    // RESOURCE_EXHAUSTED surfaces here as HTTP 409 / 429 (grpcStatusToHttp) — which
    // is exactly what the FE already renders («занято (lock)»). The gateway needs no
    // change for that; the lock itself is the search domain's part.
    const md = this.outboundMeta.build(req, { projectId: pid });
    const entityTypeList = entityTypes
      ? entityTypes
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean)
      : [];
    const result = await grpcBffCall(
      this.searchService.reindex(
        {
          project_id: pid,
          entity_types: entityTypeList,
        },
        md,
      ) as never,
      'write',
    );
    void this.auditSearchReindex(req, pid, entityTypeList, result as Record<string, unknown>);
    return result;
  }

  /**
   * FR-SEARCH-325: privileged manual reindex must leave an immutable audit trail.
   * fail-soft: audit outage must not block the operator remedy for a stale index.
   */
  private async auditSearchReindex(
    req: GrpcReq,
    projectId: string,
    entityTypes: string[],
    result: Record<string, unknown>,
  ): Promise<void> {
    try {
      await grpcBffCall(
        this.audit.appendEvent(
          {
            project_id: projectId,
            event_name: 'search.reindexed',
            entity_type: 'search',
            entity_id: projectId,
            payload_json: JSON.stringify({
              entityTypes,
              indexedCount: Number(result.indexed_count ?? result.indexedCount ?? 0),
              truncated: Boolean(result.truncated),
              skippedTypes: result.skipped_types ?? result.skippedTypes ?? [],
              ts: Date.now(),
            }),
          },
          this.outboundMeta.build(req, { projectId }),
        ) as never,
      );
    } catch (e) {
      this.logger.warn(
        `search.reindexed audit append failed (project=${projectId}): ${
          e instanceof Error ? e.message : String(e)
        }`,
      );
    }
  }

  // ─── Per-project module settings (U5 / FR-MSRCH-19) ─────────────────────────
  // Settings live in control as project `moduleConfigs[moduleId].personalSettings`
  // (sanitized server-side against the module's settingsSchema in shared/
  // module-registry). Version-neutral path mirrors the FE SearchService base
  // (`/api/projects/:id/modules/:moduleId/settings`). ProjectAccessGuard resolves
  // :projectId from the route param and enforces @RequirePermission.

  @Get('projects/:projectId/modules/:moduleId/settings')
  @ApiTags('Projects')
  @ApiBearerAuth()
  @UseGuards(ProjectAccessGuard)
  @RequirePermission('project', 'manage')
  async getModuleSettings(
    @Req() req: GrpcReq,
    @Param('projectId') projectId: string,
    @Param('moduleId') moduleId: string,
  ) {
    const md = this.outboundMeta.build(req, { projectId });
    // Dedicated RPC, NOT `getProject`: the full Project payload carries
    // personalSettings as plain JSON maps, which the Struct serializer silently
    // drops — the projection would always degrade to module defaults
    // (module-settings-struct.spec.ts in control).
    const r = (await grpcBffCall(
      this.controlProject.getModulePersonalSettings(
        { project_id: projectId, module_id: moduleId },
        md,
      ) as never,
    )) as { personal_settings?: unknown };
    // Stored settings or {} — the FE merges over its module defaults, so a
    // missing/empty config degrades gracefully.
    return structToJson(r?.personal_settings);
  }

  @Put('projects/:projectId/modules/:moduleId/settings')
  @ApiTags('Projects')
  @ApiBearerAuth()
  @UseGuards(ProjectAccessGuard)
  @RequirePermission('project', 'manage')
  async putModuleSettings(
    @Req() req: GrpcReq,
    @Param('projectId') projectId: string,
    @Param('moduleId') moduleId: string,
    @Body() body: Record<string, unknown>,
  ) {
    const md = this.outboundMeta.build(req, { projectId });
    const settings = body && typeof body === 'object' && !Array.isArray(body) ? body : {};
    const saved = (await grpcBffCall(
      this.controlProject.setModulePersonalSettings(
        {
          project_id: projectId,
          module_id: moduleId,
          // Struct wire format — a plain map serializes to an EMPTY Struct and
          // control would persist `{}` (module-settings-struct.spec.ts).
          personal_settings: jsonToStruct(settings),
          actor_user_id: req.user?.userId ?? '',
        },
        md,
      ) as never,
    )) as { personal_settings?: unknown };
    // Echo the persisted (server-side) settings for the target module.
    return saved?.personal_settings != null ? structToJson(saved.personal_settings) : settings;
  }

  // ─── Легаси-чтение аудита (депрекейтнуто в пользу /api/v1/projects/:projectId/
  // audit/events, контракт audit.md §2). Отдаёт те же записи журнала, поэтому и
  // гейт тот же, что у близнеца: членство в проекте + project:manage — иначе один
  // и тот же журнал доступен owner/admin по одному URL и любому пользователю по
  // другому. `projectId` берём только из query: именно его проверяет
  // ProjectAccessGuard. Записи здесь нет — `AuditGrpc.AppendEvent` internal
  // (service-key), путь записи — консьюмер шины (audit.md §1/§2).

  @Get('audit/events')
  @ApiTags('Audit')
  @ApiBearerAuth()
  @UseGuards(ProjectAccessGuard)
  @RequirePermission('project', 'manage')
  async listAuditEvents(
    @Req() req: GrpcReq,
    @Query('projectId') projectId: string,
    @Query('pageIndex') pageIndex?: string,
    @Query('pageSize') pageSize?: string,
    @Query('entityType') entityType?: string,
    @Query('entityId') entityId?: string,
  ) {
    const pid = requireProjectId(projectId);
    const md = this.outboundMeta.build(req, { projectId: pid });
    return grpcBffCall(
      this.audit.listEvents(
        {
          project_id: pid,
          page_index: parseInt(pageIndex ?? '0', 10),
          page_size: parseInt(pageSize ?? '25', 10),
          entity_type: entityType ?? '',
          entity_id: entityId ?? '',
        },
        md,
      ) as never,
    );
  }

  @Get('audit/events/:id')
  @ApiTags('Audit')
  @ApiBearerAuth()
  @UseGuards(ProjectAccessGuard)
  @RequirePermission('project', 'manage')
  async getAuditEvent(
    @Req() req: GrpcReq,
    @Param('id') id: string,
    @Query('projectId') projectId: string,
  ) {
    const pid = requireProjectId(projectId);
    const md = this.outboundMeta.build(req, { projectId: pid });
    return grpcBffCall(this.audit.getEvent({ project_id: pid, id }, md) as never);
  }

  /**
   * Каталог шаблонов проекта (FR-ONB-2/16/18) — единый источник FE↔BE.
   * Отдаёт статический справочник `PROJECT_TEMPLATES` из `@fairflow/shared`
   * напрямую: каталог глобален и не зависит от проекта, в домен НЕ ходим
   * (инвариант «домены только gRPC» не нарушается — gRPC-вызова здесь нет).
   * Auth: валидный JWT (контроллер под глобальным JwtAuthGuard, не `@Public`);
   * project-id не требуется. Добавление шаблона в `project-templates.ts`
   * появляется в ответе без правок FE-кода (BR-ONB-05).
   */
  @Get('project-templates')
  @ApiTags('Onboarding')
  @ApiBearerAuth()
  projectTemplates(): ProjectTemplate[] {
    return PROJECT_TEMPLATES.map((t) => ({
      id: t.id,
      name: t.name,
      description: t.description ?? '',
      modules: t.modules,
      pipeline: t.pipeline,
      dealSources: t.dealSources,
      orderTypes: t.orderTypes,
    }));
  }

  @Post('forgot-password')
  @ApiTags('Profile')
  @Public()
  async forgot(@Body() _body: { email: string }) {
    throw new HttpException(
      {
        ok: false,
        code: 'GONE',
        message: 'Use POST /v1/auth/forgot-password',
      },
      HttpStatus.GONE,
    );
  }

  @Post('reset-password')
  @ApiTags('Profile')
  @Public()
  async reset(@Body() _body: { password: string }) {
    throw new HttpException(
      {
        ok: false,
        code: 'GONE',
        message: 'Use POST /v1/auth/reset-password',
      },
      HttpStatus.GONE,
    );
  }
}
