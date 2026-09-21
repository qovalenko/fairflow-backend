import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { status, Metadata } from '@grpc/grpc-js';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { ClientGrpcProxy, Transport } from '@nestjs/microservices';
import { firstValueFrom } from 'rxjs';
import {
  GW_METADATA,
  buildGrpcLoaderOptions,
  buildServiceOutboundMetadata,
  hydrateVisibilityScope,
  serializeVisibilityScope,
} from '@fairflow/shared';
import { CONTROL_PROJECT_GRPC } from '../control/control-members.service';

type GrpcUnary = (d: unknown, m: Metadata) => import('rxjs').Observable<unknown>;

type EntityReader = {
  package: string;
  service: string;
  protoParts: string[];
  method: string;
  urlEnv: string;
  resource: string;
};

const ENTITY_READERS: Record<string, EntityReader> = {
  deal: {
    package: 'fairflow.pipe.v1',
    service: 'PipeGrpc',
    protoParts: ['fairflow', 'pipe', 'v1', 'pipe.proto'],
    method: 'GetDeal',
    urlEnv: 'PIPE_GRPC_URL',
    resource: 'deals',
  },
  contact: {
    package: 'fairflow.contact.v1',
    service: 'ContactGrpc',
    protoParts: ['fairflow', 'contact', 'v1', 'contact.proto'],
    method: 'GetContact',
    urlEnv: 'CONTACT_GRPC_URL',
    resource: 'contacts',
  },
  company: {
    package: 'fairflow.company.v1',
    service: 'CompanyGrpc',
    protoParts: ['fairflow', 'company', 'v1', 'company.proto'],
    method: 'GetCompany',
    urlEnv: 'COMPANY_GRPC_URL',
    resource: 'companies',
  },
  order: {
    package: 'fairflow.orders.v1',
    service: 'OrdersGrpc',
    protoParts: ['fairflow', 'orders', 'v1', 'orders.proto'],
    method: 'GetOrder',
    urlEnv: 'ORDERS_GRPC_URL',
    resource: 'orders',
  },
  activity: {
    package: 'fairflow.activity.v1',
    service: 'ActivityGrpc',
    protoParts: ['fairflow', 'activity', 'v1', 'activity.proto'],
    method: 'GetActivity',
    urlEnv: 'ACTIVITY_GRPC_URL',
    resource: 'activities',
  },
};

function resolveProtoPath(parts: string[]): string {
  const candidates = [
    join(process.cwd(), '..', 'proto', ...parts),
    join(process.cwd(), 'proto', ...parts),
    join(__dirname, '..', '..', '..', '..', 'proto', ...parts),
  ];
  for (const p of candidates) {
    if (existsSync(p)) return p;
  }
  return candidates[0];
}

function normalizeEntityType(entityType: string): string {
  const t = entityType.trim().toLowerCase();
  if (t === 'deals') return 'deal';
  if (t === 'contacts') return 'contact';
  if (t === 'companies') return 'company';
  if (t === 'orders') return 'order';
  if (t === 'activities') return 'activity';
  return t;
}

/**
 * FR-NOTIF-330: email egress point-check — verify the addressee can still read the
 * linked entity before sending PII outside the system.
 */
@Injectable()
export class NotificationPointCheckService {
  private readonly logger = new Logger(NotificationPointCheckService.name);
  private readonly entityClients = new Map<string, Record<string, GrpcUnary>>();
  private projectGrpc?: {
    resolveRecordVisibility: (
      d: { project_id: string; user_id: string; resource: string; inline: boolean },
      md: Metadata,
    ) => import('rxjs').Observable<{
      allowed?: boolean;
      owner_ids?: string[];
      ownerIds?: string[];
      shared_record_ids?: string[];
      sharedRecordIds?: string[];
      department_ids?: string[];
      departmentIds?: string[];
      mode?: string;
    }>;
  };

  constructor(@Inject(CONTROL_PROJECT_GRPC) private readonly controlClient: ClientGrpcProxy) {}

  private serviceApiKey(): string {
    return (
      process.env.NOTIFICATION_SERVICE_API_KEY?.trim() ||
      process.env.GATEWAY_SERVICE_API_KEY?.trim() ||
      ''
    );
  }

  private outboundMetadata(projectId: string, userId: string, visibilityScope?: string): Metadata {
    const md = buildServiceOutboundMetadata({ serviceApiKey: this.serviceApiKey() });
    md.set(GW_METADATA.PROJECT_ID, projectId);
    md.set(GW_METADATA.USER_ID, userId);
    md.set(GW_METADATA.ACTOR_TYPE, 'user');
    if (visibilityScope) md.set(GW_METADATA.VISIBILITY_SCOPE, visibilityScope);
    return md;
  }

  private getProjectGrpc(): typeof this.projectGrpc {
    if (!this.projectGrpc) {
      this.projectGrpc = this.controlClient.getService('ProjectGrpc');
    }
    return this.projectGrpc;
  }

  /** Returns true when email may leave the system for this row. Fail-closed. */
  async canSendEmail(row: {
    project_id: string;
    user_id: string;
    scope_kind?: string;
    entity_type?: string;
    entity_id?: string;
  }): Promise<boolean> {
    if (row.scope_kind === 'user') return true;
    const projectId = (row.project_id ?? '').trim();
    const userId = (row.user_id ?? '').trim();
    const entityType = (row.entity_type ?? '').trim();
    const entityId = (row.entity_id ?? '').trim();
    if (!projectId || !userId) return false;
    if (!entityType || !entityId) return true;

    const kind = normalizeEntityType(entityType);
    const reader = ENTITY_READERS[kind];
    if (!reader) return true;

    const control = this.getProjectGrpc();
    if (!control?.resolveRecordVisibility) {
      this.logger.warn('point-check skipped — control unavailable (fail-closed)');
      return false;
    }

    let scopeSerialized = serializeVisibilityScope({
      mode: 'all',
      level: 'all',
      selfId: userId,
      ownerIds: [],
      sharedRecordIds: [],
    });
    try {
      const vis = await firstValueFrom(
        control.resolveRecordVisibility(
          { project_id: projectId, user_id: userId, resource: reader.resource, inline: true },
          this.outboundMetadata(projectId, userId),
        ),
      );
      if (vis?.allowed === false) return false;
      const hydrated = hydrateVisibilityScope(
        {
          mode: vis?.mode === 'all' ? 'all' : 'restricted',
          level: 'only_own',
          selfId: userId,
          ownerIds: [],
          sharedRecordIds: [],
          resource: reader.resource,
        },
        {
          ownerIds: vis?.owner_ids ?? vis?.ownerIds ?? [],
          sharedRecordIds: vis?.shared_record_ids ?? vis?.sharedRecordIds ?? [],
          departmentIds: vis?.department_ids ?? vis?.departmentIds ?? [],
        },
      );
      scopeSerialized = serializeVisibilityScope(hydrated);
    } catch (err) {
      this.logger.warn(
        `point-check visibility failed (${projectId}/${userId}): ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return false;
    }

    const url = process.env[reader.urlEnv]?.trim();
    if (!url) {
      this.logger.warn(`point-check skipped — ${reader.urlEnv} unset (fail-closed)`);
      return false;
    }

    const svc = this.getEntityService(reader, url);
    const method = svc[reader.method];
    if (typeof method !== 'function') return false;

    try {
      await firstValueFrom(
        method({ project_id: projectId, id: entityId }, this.outboundMetadata(projectId, userId, scopeSerialized)),
      );
      return true;
    } catch (err) {
      const code = (err as { code?: number } | null)?.code;
      if (code === status.NOT_FOUND || code === status.PERMISSION_DENIED) return false;
      this.logger.warn(
        `point-check entity read failed (${kind}/${entityId}): ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return false;
    }
  }

  private getEntityService(reader: EntityReader, url: string): Record<string, GrpcUnary> {
    const cached = this.entityClients.get(reader.urlEnv);
    if (cached) return cached;
    const client = new ClientGrpcProxy({
      transport: Transport.GRPC,
      options: {
        package: reader.package,
        protoPath: resolveProtoPath(reader.protoParts),
        url,
        loader: buildGrpcLoaderOptions({ enums: String, defaults: true, oneofs: true }),
      },
    } as never);
    const svc = client.getService(reader.service) as Record<string, GrpcUnary>;
    this.entityClients.set(reader.urlEnv, svc);
    return svc;
  }
}
