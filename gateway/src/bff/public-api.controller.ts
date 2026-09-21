import { Controller, Get, Inject, Query, Req, UseGuards } from '@nestjs/common';
import { ClientGrpcProxy } from '@nestjs/microservices';
import { ApiTags, ApiSecurity } from '@nestjs/swagger';
import type { Observable } from 'rxjs';
import { grpcBffCall } from './grpc-bff-call';
import { GatewayOutboundMetadataService } from './gateway-outbound-metadata.service';
import { Public } from '../common/public.decorator';
import { ProjectApiKeyGuard, type ApiKeyRequest } from '../auth/guards/project-api-key.guard';

/** Upper bound on public page size (defence in depth; domains clamp too). */
const MAX_PAGE_SIZE = 100;
const DEFAULT_PAGE_SIZE = 25;

function clampPageSize(raw?: string): number {
  const n = parseInt(raw ?? String(DEFAULT_PAGE_SIZE), 10);
  if (!Number.isFinite(n)) return DEFAULT_PAGE_SIZE;
  return Math.min(Math.max(n, 1), MAX_PAGE_SIZE);
}

function pageIndexOf(raw?: string): number {
  const n = parseInt(raw ?? '0', 10);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

type ListResult = { list?: Record<string, unknown>[]; total?: number };

type ContactClient = {
  listContacts: (x: unknown, m?: unknown) => Observable<ListResult>;
};
type PipeClient = {
  listDeals: (x: unknown, m?: unknown) => Observable<ListResult>;
};

/** Curated, stable public projection of a contact (no internal/denorm fields). */
function contactPublic(c: Record<string, unknown>) {
  return {
    id: c.id,
    firstName: c.first_name,
    lastName: c.last_name,
    email: c.email,
    phone: c.phone,
    companyId: (c.company_ids as string[] | undefined)?.[0],
    createdAt: c.created_at,
    updatedAt: c.updated_at,
  };
}

/** Curated, stable public projection of a deal. */
function dealPublic(d: Record<string, unknown>) {
  return {
    id: d.id,
    name: d.name,
    amount: d.amount,
    currency: d.currency,
    stageId: d.stage_id,
    stageName: d.stage_name,
    status: d.status,
    contactId: d.contact_id || undefined,
    companyId: d.company_id || undefined,
    createdAt: d.created_at,
    updatedAt: d.updated_at,
    wonAt: d.won_at || undefined,
    lostAt: d.lost_at || undefined,
  };
}

/**
 * Public project API (BX-INTEG-2, BOX-INTEGRATIONS §2.1/§3).
 *
 * Read-only surface an external system reaches with a project `ffk_…` key:
 * `Authorization: Bearer ffk_…` (or `X-Api-Key: ffk_…`). Every route is
 * `@Public()` (bypasses the JWT `JwtOrPublicGuard`) but gated by
 * `ProjectApiKeyGuard` — an invalid/missing/revoked key ⇒ `401`.
 *
 * Project isolation: `projectId` comes STRICTLY from the resolved key
 * (`req.apiKeyPrincipal`), never from the URL/query — a key of project A cannot
 * read project B. The outbound metadata carries a `mode:'all'` read scope, so
 * the caller sees every record of ITS project (single-tenant, project-scoped),
 * with no write capability (only GET routes exist here).
 */
@ApiTags('Public API')
@ApiSecurity('projectApiKey')
@Public()
@UseGuards(ProjectApiKeyGuard)
@Controller({ path: 'public', version: '1' })
export class PublicApiController {
  private contact?: ContactClient;
  private pipe?: PipeClient;

  constructor(
    @Inject('CONTACT_GRPC') private readonly contactClient: ClientGrpcProxy,
    @Inject('PIPE_GRPC') private readonly pipeClient: ClientGrpcProxy,
    private readonly outboundMeta: GatewayOutboundMetadataService,
  ) {}

  private getContact(): ContactClient {
    if (!this.contact) this.contact = this.contactClient.getService<ContactClient>('ContactGrpc');
    return this.contact;
  }

  private getPipe(): PipeClient {
    if (!this.pipe) this.pipe = this.pipeClient.getService<PipeClient>('PipeGrpc');
    return this.pipe;
  }

  @Get('contacts')
  async listContacts(
    @Req() req: ApiKeyRequest,
    @Query('pageIndex') pageIndex?: string,
    @Query('pageSize') pageSize?: string,
    @Query('query') query?: string,
  ) {
    const projectId = req.apiKeyPrincipal!.projectId;
    const md = this.outboundMeta.buildForApiKey(req as never, { projectId });
    const r = await grpcBffCall(
      this.getContact().listContacts(
        {
          project_id: projectId,
          page_index: pageIndexOf(pageIndex),
          page_size: clampPageSize(pageSize),
          query: query ?? '',
        },
        md,
      ),
    );
    const list = Array.isArray(r.list) ? r.list : [];
    return {
      list: list.map(contactPublic),
      total: typeof r.total === 'number' ? r.total : list.length,
    };
  }

  @Get('deals')
  async listDeals(
    @Req() req: ApiKeyRequest,
    @Query('pageIndex') pageIndex?: string,
    @Query('pageSize') pageSize?: string,
    @Query('query') query?: string,
  ) {
    const projectId = req.apiKeyPrincipal!.projectId;
    const md = this.outboundMeta.buildForApiKey(req as never, { projectId });
    const r = await grpcBffCall(
      this.getPipe().listDeals(
        {
          project_id: projectId,
          page_index: pageIndexOf(pageIndex),
          page_size: clampPageSize(pageSize),
          query: query ?? '',
        },
        md,
      ),
    );
    const list = Array.isArray(r.list) ? r.list : [];
    return {
      list: list.map(dealPublic),
      total: typeof r.total === 'number' ? r.total : list.length,
    };
  }
}
