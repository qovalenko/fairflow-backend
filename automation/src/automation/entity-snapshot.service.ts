import { status, Metadata } from '@grpc/grpc-js';
import { GW_METADATA } from '@fairflow/shared';
import { Injectable, Logger } from '@nestjs/common';
import { ClientGrpcProxy, Transport } from '@nestjs/microservices';
import { firstValueFrom } from 'rxjs';
import {
  AUTOMATION_GRPC_LOADER_OPTIONS,
  protoPath,
} from './executors/grpc-action-executor';

type GrpcUnary = (
  d: unknown,
  m: Metadata,
) => import('rxjs').Observable<unknown>;

type EntityReader = {
  package: string;
  service: string;
  proto: string[];
  method: string;
  urlEnv: string;
};

const ENTITY_READERS: Record<string, EntityReader> = {
  deal: {
    package: 'fairflow.pipe.v1',
    service: 'PipeGrpc',
    proto: ['fairflow', 'pipe', 'v1', 'pipe.proto'],
    method: 'GetDeal',
    urlEnv: 'PIPE_GRPC_URL',
  },
  contact: {
    package: 'fairflow.contact.v1',
    service: 'ContactGrpc',
    proto: ['fairflow', 'contact', 'v1', 'contact.proto'],
    method: 'GetContact',
    urlEnv: 'CONTACT_GRPC_URL',
  },
  company: {
    package: 'fairflow.company.v1',
    service: 'CompanyGrpc',
    proto: ['fairflow', 'company', 'v1', 'company.proto'],
    method: 'GetCompany',
    urlEnv: 'COMPANY_GRPC_URL',
  },
  order: {
    package: 'fairflow.orders.v1',
    service: 'OrdersGrpc',
    proto: ['fairflow', 'orders', 'v1', 'orders.proto'],
    method: 'GetOrder',
    urlEnv: 'ORDERS_GRPC_URL',
  },
  activity: {
    package: 'fairflow.activity.v1',
    service: 'ActivityGrpc',
    proto: ['fairflow', 'activity', 'v1', 'activity.proto'],
    method: 'GetActivity',
    urlEnv: 'ACTIVITY_GRPC_URL',
  },
};

const PROPAGATE_KEYS: readonly string[] = [
  GW_METADATA.REQUEST_ID,
  GW_METADATA.TRACE_ID,
  GW_METADATA.TRACEPARENT,
  GW_METADATA.GATEWAY_ISSUED_AT,
  GW_METADATA.VISIBILITY_SCOPE,
  GW_METADATA.ACCESS_PREDICATE,
  GW_METADATA.ROLES,
  GW_METADATA.PERMISSIONS,
  GW_METADATA.ENABLED_MODULES,
];

function normalizeEntityType(entityType: string): string {
  const t = entityType.trim().toLowerCase();
  if (t === 'deals') return 'deal';
  if (t === 'contacts') return 'contact';
  if (t === 'companies') return 'company';
  if (t === 'orders') return 'order';
  if (t === 'activities') return 'activity';
  return t;
}

function buildPropagatedMetadata(
  inbound: Metadata | undefined,
  projectId: string,
  userId: string,
): Metadata {
  const m = new Metadata();
  m.set(GW_METADATA.SERVICE_API_KEY, process.env.AUTOMATION_SERVICE_API_KEY ?? '');
  m.set(GW_METADATA.GATEWAY_API_KEY_ID, process.env.AUTOMATION_API_KEY_ID ?? '');
  m.set(GW_METADATA.PROJECT_ID, projectId);
  m.set(GW_METADATA.ACTOR_TYPE, userId ? 'user' : 'service');
  if (userId) m.set(GW_METADATA.USER_ID, userId);
  if (!inbound) return m;
  for (const key of PROPAGATE_KEYS) {
    const v = inbound.get(key)?.[0];
    if (v != null) m.set(key, typeof v === 'string' ? v : v.toString());
  }
  return m;
}

/**
 * Cross-domain entity read for ManualRun (§3.8 IDOR mitigation): fetches the
 * target record under the caller's propagated visibility/ABAC metadata. NOT_FOUND
 * when the record is missing or out of scope — never leaks existence.
 */
@Injectable()
export class EntitySnapshotService {
  private readonly logger = new Logger(EntitySnapshotService.name);
  private readonly clients = new Map<string, Record<string, GrpcUnary>>();

  async fetchRecord(
    projectId: string,
    entityType: string,
    entityId: string,
    userId: string,
    inbound?: Metadata,
  ): Promise<Record<string, unknown>> {
    const kind = normalizeEntityType(entityType);
    const reader = ENTITY_READERS[kind];
    if (!reader) {
      throw Object.assign(new Error(`unsupported entity_type: ${entityType}`), {
        code: status.INVALID_ARGUMENT,
      });
    }
    const url = process.env[reader.urlEnv]?.trim();
    if (!url) {
      throw Object.assign(new Error('entity_reader_unavailable'), {
        code: status.FAILED_PRECONDITION,
      });
    }
    const svc = this.getService(reader, url);
    const method = svc[reader.method];
    if (typeof method !== 'function') {
      throw Object.assign(new Error('entity_reader_unavailable'), {
        code: status.FAILED_PRECONDITION,
      });
    }
    const md = buildPropagatedMetadata(inbound, projectId, userId);
    try {
      const record = (await firstValueFrom(
        method({ project_id: projectId, id: entityId }, md),
      )) as Record<string, unknown>;
      return {
        entity_type: kind,
        entity_id: entityId,
        record,
        ...this.flattenRecord(record, kind),
      };
    } catch (err) {
      const code = (err as { code?: number } | null)?.code;
      if (code === status.NOT_FOUND || code === status.PERMISSION_DENIED) {
        throw Object.assign(new Error('Entity not found'), { code: status.NOT_FOUND });
      }
      this.logger.warn(
        `Entity read failed (${kind}/${entityId}): ${err instanceof Error ? err.message : String(err)}`,
      );
      throw Object.assign(new Error('Entity not found'), { code: status.NOT_FOUND });
    }
  }

  private getService(reader: EntityReader, url: string): Record<string, GrpcUnary> {
    const cached = this.clients.get(reader.urlEnv);
    if (cached) return cached;
    const client = new ClientGrpcProxy({
      transport: Transport.GRPC,
      package: reader.package,
      protoPath: protoPath(...reader.proto),
      url,
      loader: AUTOMATION_GRPC_LOADER_OPTIONS,
    } as never);
    const svc = client.getService(reader.service) as Record<string, GrpcUnary>;
    this.clients.set(reader.urlEnv, svc);
    return svc;
  }

  /** Best-effort flat fields for condition evaluation on manual-run payloads. */
  private flattenRecord(
    record: Record<string, unknown>,
    kind: string,
  ): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(record)) {
      if (v != null && typeof v !== 'object') out[k] = v;
    }
    if (kind === 'deal') {
      out.deal_id = record.id;
      out.amount = record.amount;
      out.stage_id = record.stage_id ?? record.stageId;
      out.assignee_id = record.assignee_id ?? record.assigneeId;
    }
    if (kind === 'contact') {
      out.contact_id = record.id;
    }
    if (kind === 'company') {
      out.company_id = record.id;
    }
    if (kind === 'order') {
      out.order_id = record.id;
      out.status = record.status;
    }
    return out;
  }
}
