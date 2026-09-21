import { Controller } from '@nestjs/common';
import { GrpcMethod } from '@nestjs/microservices';
import type { Metadata } from '@grpc/grpc-js';
import {
  resolveProjectId,
  readVisibilityScope,
  parseEnabledModulesHeader,
  readGatewayMetadata,
  readAccessPredicate,
  GW_METADATA,
} from '@fairflow/shared';
import { SearchService, normalizeOwnerScope, type SearchAccessContext } from './search.service';

/** Build the per-request access context from trusted gateway metadata. The
 * domain never parses JWT — it only applies what the gateway resolved. */
function readAccessContext(metadata?: Metadata): SearchAccessContext {
  const ctx: SearchAccessContext = {};
  const scope = readVisibilityScope(metadata);
  if (scope) ctx.scope = scope;
  // TODO-262: the viewer's own id, for the `my` scope preset. The resolved scope
  // is the primary source; x-user-id is the fallback for a scope that arrived
  // without selfId. Never used to widen a read — only to narrow it.
  const selfId = scope?.selfId || readGatewayMetadata(metadata, GW_METADATA.USER_ID) || '';
  if (selfId) ctx.selfId = selfId;
  const modules = parseEnabledModulesHeader(readGatewayMetadata(metadata, GW_METADATA.ENABLED_MODULES));
  if (modules) ctx.enabledModules = modules;
  // ABAC predicate (x-access-predicate) is read via the shared three-state helper
  // so search fails CLOSED on a broken predicate — a malformed/undecodable header
  // is a broken deny-rule and must never silently widen access (RFC-ABAC §4,
  // matches the product reference; previously search swallowed the parse error and
  // dropped the narrowing = fail-open, P8 T3.2b).
  const access = readAccessPredicate(metadata);
  if (access.present && access.malformed) {
    ctx.accessMalformed = true;
  } else if (access.present && 'mongo' in access && access.mongo && Object.keys(access.mongo).length) {
    ctx.accessPredicate = access.mongo;
  }
  return ctx;
}

function csv(v?: string[] | string): string[] | undefined {
  if (!v) return undefined;
  const arr = Array.isArray(v) ? v : String(v).split(',');
  const out = arr.map((s) => s.trim()).filter(Boolean);
  return out.length ? out : undefined;
}

// T-018: search is a CROSS-CUTTING capability, not an opt-in business module —
// the gateway deliberately exposes /search without @RequireModule('search'), so
// the domain controller must not re-gate on it either (no project enables the
// `search` module by default → the class-level gate 403'd EVERY query). Module
// scoping is enforced per entity type instead: SearchService intersects the
// effective types with `x-enabled-modules` from the trusted gateway metadata.
@Controller()
export class SearchGrpcController {
  constructor(private readonly search: SearchService) {}

  @GrpcMethod('SearchGrpc', 'Search')
  query(
    d: {
      project_id?: string;
      projectId?: string;
      query?: string;
      page_index?: number;
      page_size?: number;
      entity_types?: string[];
      per_type_limit?: number;
      group_by?: string;
      // TODO-262 (FR-SEARCH-140): UI scope preset + the departments the GATEWAY
      // resolved for the viewer. keepCase-tolerant like every other field here.
      owner_scope?: string;
      ownerScope?: string;
      scope_department_ids?: string[];
      scopeDepartmentIds?: string[];
      min_query_chars?: number;
      minQueryChars?: number;
    },
    metadata?: Metadata,
  ) {
    const projectId = resolveProjectId(metadata, d.project_id ?? d.projectId);
    return this.search.search(projectId, d.query ?? '', d.page_index ?? 0, d.page_size ?? 25, {
      entityTypes: csv(d.entity_types),
      perTypeLimit: d.per_type_limit,
      groupBy: d.group_by,
      ownerScope: normalizeOwnerScope(d.owner_scope ?? d.ownerScope),
      scopeDepartmentIds: csv(d.scope_department_ids ?? d.scopeDepartmentIds) ?? [],
      minQueryChars: d.min_query_chars ?? d.minQueryChars,
      ctx: readAccessContext(metadata),
    });
  }

  @GrpcMethod('SearchGrpc', 'Reindex')
  reindex(d: { project_id?: string; projectId?: string; entity_types?: string[] }, metadata?: Metadata) {
    const projectId = resolveProjectId(metadata, d.project_id ?? d.projectId);
    return this.search.reindex(projectId, csv(d.entity_types));
  }

  @GrpcMethod('SearchGrpc', 'Status')
  status(d: { project_id?: string; projectId?: string }, metadata?: Metadata) {
    const projectId = resolveProjectId(metadata, d.project_id ?? d.projectId);
    return this.search.status(projectId);
  }

  @GrpcMethod('SearchGrpc', 'IndexUpsert')
  indexUpsert(
    d: {
      project_id?: string;
      entity_type?: string;
      entity_id?: string;
      title?: string;
      subtitle?: string;
      path?: string;
      tokens?: string;
      owner_id?: string;
      department_id?: string;
      owner_field?: string;
      abac_attrs?: Record<string, unknown>;
      source_updated_at?: number;
      version?: number;
    },
    metadata?: Metadata,
  ) {
    const projectId = resolveProjectId(metadata, d.project_id);
    return this.search.indexUpsert({
      projectId,
      entityType: d.entity_type ?? '',
      entityId: d.entity_id ?? '',
      title: d.title,
      subtitle: d.subtitle,
      path: d.path,
      tokens: d.tokens,
      ownerId: d.owner_id,
      departmentId: d.department_id,
      ownerField: d.owner_field,
      abacAttrs: d.abac_attrs,
      sourceUpdatedAt: d.source_updated_at,
      version: d.version,
    });
  }

  @GrpcMethod('SearchGrpc', 'IndexDelete')
  indexDelete(
    d: { project_id?: string; entity_type?: string; entity_id?: string; version?: number },
    metadata?: Metadata,
  ) {
    const projectId = resolveProjectId(metadata, d.project_id);
    return this.search.indexDelete({
      projectId,
      entityType: d.entity_type ?? '',
      entityId: d.entity_id ?? '',
      version: d.version,
    });
  }

  @GrpcMethod('SearchGrpc', 'ListUnassigned')
  listUnassigned(
    d: { project_id?: string; resource?: string; limit?: number; cursor?: string },
    metadata?: Metadata,
  ) {
    const projectId = resolveProjectId(metadata, d.project_id);
    return this.search.listUnassigned(projectId, d.resource ?? 'all', d.limit ?? 50, d.cursor).then(
      (r) => ({
        list: r.list.map((row) => ({
          entity_type: row.entityType,
          entity_id: row.entityId,
          title: row.title,
          updated_at: row.updatedAt,
        })),
        next_cursor: r.nextCursor,
        total: r.total,
      }),
    );
  }
}
