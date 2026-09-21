import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ClientGrpcProxy } from '@nestjs/microservices';
import { Metadata } from '@grpc/grpc-js';
import { firstValueFrom } from 'rxjs';
import { AppError, buildServiceOutboundMetadata, GW_METADATA } from '@fairflow/shared';

type MemberOwnedGrpc = {
  countMemberOwnedRecords: (
    data: { project_id: string; user_id: string },
    metadata?: Metadata,
  ) => unknown;
  reassignMemberOwnedRecords: (
    data: { project_id: string; from_user_id: string; to_user_id: string },
    metadata?: Metadata,
  ) => unknown;
};

/** CRM domain adapters for FR-PROJ-215 owned-record guard. */
const DOMAIN_ADAPTERS: Array<{
  domain: string;
  moduleId: string;
  clientToken: string;
  serviceName: string;
}> = [
  {
    domain: 'contacts',
    moduleId: 'contacts',
    clientToken: 'CONTACT_GRPC',
    serviceName: 'ContactGrpc',
  },
  {
    domain: 'companies',
    moduleId: 'companies',
    clientToken: 'COMPANY_GRPC',
    serviceName: 'CompanyGrpc',
  },
  { domain: 'deals', moduleId: 'deals', clientToken: 'PIPE_GRPC', serviceName: 'PipeGrpc' },
  { domain: 'orders', moduleId: 'orders', clientToken: 'ORDERS_GRPC', serviceName: 'OrdersGrpc' },
  {
    domain: 'activities',
    moduleId: 'activities',
    clientToken: 'ACTIVITY_GRPC',
    serviceName: 'ActivityGrpc',
  },
  {
    domain: 'documents',
    moduleId: 'documents',
    clientToken: 'DOCUMENTS_GRPC',
    serviceName: 'DocumentsGrpc',
  },
];

export type OwnedRecordBreakdown = { domain: string; count: number };

@Injectable()
export class MemberOwnedRecordsService implements OnModuleInit {
  private readonly logger = new Logger(MemberOwnedRecordsService.name);
  private readonly clients = new Map<string, MemberOwnedGrpc>();

  constructor(
    @Inject('CONTACT_GRPC') private readonly contactClient: ClientGrpcProxy,
    @Inject('COMPANY_GRPC') private readonly companyClient: ClientGrpcProxy,
    @Inject('PIPE_GRPC') private readonly pipeClient: ClientGrpcProxy,
    @Inject('ORDERS_GRPC') private readonly ordersClient: ClientGrpcProxy,
    @Inject('ACTIVITY_GRPC') private readonly activityClient: ClientGrpcProxy,
    @Inject('DOCUMENTS_GRPC') private readonly documentsClient: ClientGrpcProxy,
  ) {}

  onModuleInit() {
    const byToken: Record<string, ClientGrpcProxy> = {
      CONTACT_GRPC: this.contactClient,
      COMPANY_GRPC: this.companyClient,
      PIPE_GRPC: this.pipeClient,
      ORDERS_GRPC: this.ordersClient,
      ACTIVITY_GRPC: this.activityClient,
      DOCUMENTS_GRPC: this.documentsClient,
    };
    for (const adapter of DOMAIN_ADAPTERS) {
      const client = byToken[adapter.clientToken];
      this.clients.set(adapter.domain, client.getService<MemberOwnedGrpc>(adapter.serviceName));
    }
  }

  private serviceMeta(projectId: string): Metadata {
    const m = buildServiceOutboundMetadata({
      serviceApiKey:
        process.env.GATEWAY_SERVICE_API_KEY ?? process.env.CONTROL_SERVICE_API_KEY ?? '',
    });
    if (projectId) m.set(GW_METADATA.PROJECT_ID, projectId);
    return m;
  }

  /**
   * FR-PROJ-340: disabling a module does not delete its records, so the owned
   * guard must query every CRM domain that exposes the RPC — not only currently
   * enabled modules. `enabledModules` is kept for call-site compatibility.
   */
  private targetDomains(_enabledModules: string[]): typeof DOMAIN_ADAPTERS {
    return DOMAIN_ADAPTERS;
  }

  async countOwned(
    projectId: string,
    userId: string,
    enabledModules: string[],
  ): Promise<{ total: number; breakdown: OwnedRecordBreakdown[] }> {
    const breakdown: OwnedRecordBreakdown[] = [];
    let total = 0;
    const meta = this.serviceMeta(projectId);
    for (const adapter of this.targetDomains(enabledModules)) {
      const svc = this.clients.get(adapter.domain);
      if (!svc) {
        throw new AppError('internal', `Could not verify owned records in ${adapter.domain}`, {
          reason: 'OWNED_RECORDS_CHECK_FAILED',
          domain: adapter.domain,
        });
      }
      try {
        const res = (await firstValueFrom(
          svc.countMemberOwnedRecords({ project_id: projectId, user_id: userId }, meta) as never,
        )) as { count?: number };
        const count = Number(res?.count ?? 0);
        if (count > 0) breakdown.push({ domain: adapter.domain, count });
        total += count;
      } catch (err) {
        this.logger.warn(
          `countMemberOwnedRecords(${adapter.domain}) failed: ${(err as Error)?.message ?? err}`,
        );
        throw new AppError('internal', `Could not verify owned records in ${adapter.domain}`, {
          reason: 'OWNED_RECORDS_CHECK_FAILED',
          domain: adapter.domain,
        });
      }
    }
    return { total, breakdown };
  }

  async reassignOwned(
    projectId: string,
    fromUserId: string,
    toUserId: string,
    enabledModules: string[],
  ): Promise<number> {
    const meta = this.serviceMeta(projectId);
    let reassigned = 0;
    for (const adapter of this.targetDomains(enabledModules)) {
      const svc = this.clients.get(adapter.domain);
      if (!svc) {
        throw new AppError('internal', `Could not reassign owned records in ${adapter.domain}`, {
          reason: 'OWNED_RECORDS_REASSIGN_FAILED',
          domain: adapter.domain,
        });
      }
      try {
        const res = (await firstValueFrom(
          svc.reassignMemberOwnedRecords(
            {
              project_id: projectId,
              from_user_id: fromUserId,
              to_user_id: toUserId,
            },
            meta,
          ) as never,
        )) as { reassigned?: number };
        reassigned += Number(res?.reassigned ?? 0);
      } catch (err) {
        this.logger.warn(
          `reassignMemberOwnedRecords(${adapter.domain}) failed: ${(err as Error)?.message ?? err}`,
        );
        throw err;
      }
    }
    return reassigned;
  }
}
