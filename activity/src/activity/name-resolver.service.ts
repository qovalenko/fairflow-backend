import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ClientGrpcProxy } from '@nestjs/microservices';
import { Metadata, status as grpcStatus } from '@grpc/grpc-js';
import { firstValueFrom, timeout, type Observable } from 'rxjs';
import { GW_METADATA, newEntityId, serializeVisibilityScope } from '@fairflow/shared';

/**
 * s2s admin visibility scope: `mode:'all'` short-circuits the donors'
 * `isRecordVisible`/`buildVisibilityFilter` to "visible" (rbac.ts). Without this
 * header the donors read `undefined` and fail-closed (Д-3) → every existing entity
 * answers NOT_FOUND and would be mis-flagged orphaned. A trusted s2s caller (its
 * x-service-api-key is validated by the donor) is authorised to read any record in
 * the project for the sole purpose of snapshotting the display name.
 */
const SERVICE_SCOPE = serializeVisibilityScope({
  mode: 'all',
  level: 'all',
  selfId: '',
  ownerIds: [],
  sharedRecordIds: [],
});

/** Link (subset) that the resolver enriches with a display-name snapshot. */
export interface ResolvableLink {
  entityType: string;
  entityId: string;
  nameSnapshot?: string;
  orphaned?: boolean;
}

/** Per-link resolution outcome. */
interface Resolution {
  nameSnapshot: string;
  /** true ONLY when the donor explicitly answered NOT_FOUND (S2 orphan). */
  orphaned: boolean;
}

interface ContactSvc {
  getContact: (
    d: { project_id: string; id: string },
    metadata?: Metadata,
  ) => Observable<{ first_name?: string; last_name?: string; middle_name?: string }>;
}
interface CompanySvc {
  getCompany: (
    d: { project_id: string; id: string },
    metadata?: Metadata,
  ) => Observable<{ name?: string }>;
}
interface PipeSvc {
  getDeal: (
    d: { project_id: string; id: string },
    metadata?: Metadata,
  ) => Observable<{ name?: string }>;
}
interface OrdersSvc {
  getOrder: (
    d: { project_id: string; id: string },
    metadata?: Metadata,
  ) => Observable<{ number?: string; type_name?: string }>;
}

const RESOLVE_TIMEOUT_MS = Number(process.env.ACTIVITY_NAME_RESOLVE_TIMEOUT_MS ?? 2000);

/**
 * Resolves the human-readable `nameSnapshot` for activity links by reading the
 * owning CRM domain over gRPC (contact/company/pipe/orders) with a service-to-service
 * metadata envelope (x-service-api-key + propagated context). Every read carries the
 * activity's `project_id`, so a foreign projectId can never read another tenant's
 * entity (isolation S7).
 *
 * Fail-soft contract:
 *  - donor answers with the entity → nameSnapshot = display name, orphaned = false;
 *  - donor answers NOT_FOUND        → nameSnapshot = '', orphaned = TRUE (dangling link);
 *  - timeout / donor down / other   → nameSnapshot = '', orphaned = false (unknown, not orphan).
 * Creating/updating an activity never fails because a donor is unreachable.
 */
@Injectable()
export class NameResolverService implements OnModuleInit {
  private readonly logger = new Logger(NameResolverService.name);
  private contact!: ContactSvc;
  private company!: CompanySvc;
  private pipe!: PipeSvc;
  private orders!: OrdersSvc;
  private readonly apiKey =
    process.env.ACTIVITY_SERVICE_API_KEY ?? process.env.GATEWAY_SERVICE_API_KEY ?? '';

  constructor(
    @Inject('CONTACT_GRPC') private readonly contactClient: ClientGrpcProxy,
    @Inject('COMPANY_GRPC') private readonly companyClient: ClientGrpcProxy,
    @Inject('PIPE_GRPC') private readonly pipeClient: ClientGrpcProxy,
    @Inject('ORDERS_GRPC') private readonly ordersClient: ClientGrpcProxy,
  ) {}

  onModuleInit(): void {
    this.contact = this.contactClient.getService<ContactSvc>('ContactGrpc');
    this.company = this.companyClient.getService<CompanySvc>('CompanyGrpc');
    this.pipe = this.pipeClient.getService<PipeSvc>('PipeGrpc');
    this.orders = this.ordersClient.getService<OrdersSvc>('OrdersGrpc');
  }

  /** s2s metadata accepted by the donor inbound api-key guards. */
  private meta(projectId: string): Metadata {
    const m = new Metadata();
    if (this.apiKey) m.set(GW_METADATA.SERVICE_API_KEY, this.apiKey);
    m.set(GW_METADATA.REQUEST_ID, newEntityId());
    m.set(GW_METADATA.TRACE_ID, newEntityId());
    m.set(GW_METADATA.GATEWAY_ISSUED_AT, String(Date.now()));
    m.set(GW_METADATA.ACTOR_TYPE, 'service');
    m.set(GW_METADATA.PROJECT_ID, projectId);
    // mode:'all' scope — donors fail-closed (deny-all) without a resolved scope.
    m.set(GW_METADATA.VISIBILITY_SCOPE, SERVICE_SCOPE);
    return m;
  }

  /** True when the RPC rejection is an explicit gRPC NOT_FOUND. */
  private isNotFound(err: unknown): boolean {
    const code = (err as { code?: number } | null)?.code;
    return code === grpcStatus.NOT_FOUND;
  }

  private displayContact(r: {
    first_name?: string;
    last_name?: string;
    middle_name?: string;
  }): string {
    return [r.first_name, r.middle_name, r.last_name]
      .map((s) => (s ?? '').trim())
      .filter(Boolean)
      .join(' ')
      .trim();
  }

  /** Resolve a single link; never throws (errors mapped to a fail-soft Resolution). */
  private async resolveOne(
    projectId: string,
    entityType: string,
    entityId: string,
  ): Promise<Resolution> {
    const meta = this.meta(projectId);
    const req = { project_id: projectId, id: entityId };
    try {
      switch (entityType) {
        case 'contact': {
          const r = await firstValueFrom(
            this.contact.getContact(req, meta).pipe(timeout(RESOLVE_TIMEOUT_MS)),
          );
          return { nameSnapshot: this.displayContact(r), orphaned: false };
        }
        case 'company': {
          const r = await firstValueFrom(
            this.company.getCompany(req, meta).pipe(timeout(RESOLVE_TIMEOUT_MS)),
          );
          return { nameSnapshot: (r.name ?? '').trim(), orphaned: false };
        }
        case 'deal': {
          const r = await firstValueFrom(
            this.pipe.getDeal(req, meta).pipe(timeout(RESOLVE_TIMEOUT_MS)),
          );
          return { nameSnapshot: (r.name ?? '').trim(), orphaned: false };
        }
        case 'order': {
          const r = await firstValueFrom(
            this.orders.getOrder(req, meta).pipe(timeout(RESOLVE_TIMEOUT_MS)),
          );
          return { nameSnapshot: (r.number ?? r.type_name ?? '').trim(), orphaned: false };
        }
        default:
          return { nameSnapshot: '', orphaned: false };
      }
    } catch (err) {
      if (this.isNotFound(err)) {
        // Donor is up and says the entity does not exist → dangling link.
        return { nameSnapshot: '', orphaned: true };
      }
      // Timeout / UNAVAILABLE / other transient error → unknown, do NOT mark orphaned.
      this.logger.warn(`resolve ${entityType}/${entityId} failed: ${String(err)}`);
      return { nameSnapshot: '', orphaned: false };
    }
  }

  /**
   * Enrich links[] with `nameSnapshot`/`orphaned` in place of empty snapshots.
   * Dedupes identical `entityType:entityId` pairs, resolves all in parallel.
   * Returns new link objects; input is not mutated.
   */
  async resolveLinks<T extends ResolvableLink>(
    projectId: string,
    links: T[],
  ): Promise<Array<T & { nameSnapshot: string; orphaned: boolean }>> {
    if (!projectId || links.length === 0) {
      return links as Array<T & { nameSnapshot: string; orphaned: boolean }>;
    }
    // Dedupe: one RPC per distinct entity even if linked twice.
    const cache = new Map<string, Promise<Resolution>>();
    const keyOf = (l: ResolvableLink) => `${l.entityType}:${l.entityId}`;
    for (const l of links) {
      if (!l.entityType || !l.entityId) continue;
      const k = keyOf(l);
      if (!cache.has(k)) cache.set(k, this.resolveOne(projectId, l.entityType, l.entityId));
    }
    const results = await Promise.all(
      links.map(async (l) => {
        const p = l.entityType && l.entityId ? cache.get(keyOf(l)) : undefined;
        const res = p ? await p : { nameSnapshot: '', orphaned: false };
        return { ...l, nameSnapshot: res.nameSnapshot, orphaned: res.orphaned };
      }),
    );
    return results;
  }
}
