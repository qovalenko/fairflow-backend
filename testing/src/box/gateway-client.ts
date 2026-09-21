import { Metadata } from '@grpc/grpc-js';
import { uniqueBoxName, BOX_GATEWAY_API_BASE, LOCAL_GATEWAY_API_BASE } from './conn';
import { boxServiceMetadata, createBoxPeerGrpcClients, type BoxPeerGrpcClients } from './box-grpc';
import { resolveBoxSystemContext, type BoxSystemContext } from './box-system-context';
import { waitFor } from './wait-for';

/**
 * Box stand integration harness — creates isolated test projects via control gRPC
 * (service-key auth + platform owner actor). Avoids gateway JWT login, which is
 * rate-limited on shared the box stand.
 */
export class BoxGatewayClient {
  readonly token = 'service-key-harness';
  readonly userId: string;
  private readonly systemOrgId: string;
  private readonly grpc: BoxPeerGrpcClients;
  private readonly modules: string[];

  private constructor(ctx: BoxSystemContext, grpc: BoxPeerGrpcClients, modules: string[]) {
    this.userId = ctx.platformOwnerUserId;
    this.systemOrgId = ctx.systemOrgId;
    this.grpc = grpc;
    this.modules = modules;
  }

  static async login(
    modules: string[] = [
      'contacts',
      'companies',
      'deals',
      'products',
      'orders',
      'search',
      'automation',
      'activities',
    ],
  ): Promise<BoxGatewayClient> {
    const [ctx, grpc] = await Promise.all([
      resolveBoxSystemContext(),
      Promise.resolve(createBoxPeerGrpcClients()),
    ]);
    return new BoxGatewayClient(ctx, grpc, modules);
  }

  private md(projectId: string): Metadata {
    return boxServiceMetadata(projectId, this.userId, this.modules);
  }

  async createProject(name: string, modules: string[]): Promise<string> {
    const res = await this.grpc.control.createProject(
      {
        owner_type: 'organization',
        owner_id: this.systemOrgId,
        name,
        template_id: 'blank',
        modules,
        created_by_user_id: this.userId,
      },
      this.md(''),
    );
    const projectId = String(res.id ?? '');
    if (!projectId) throw new Error('createProject: missing id in response');

    await waitFor(
      async () => {
        const pipes = await this.grpc.pipe.listPipelines({ project_id: projectId }, this.md(projectId));
        const list = (pipes.list ?? pipes.pipelines ?? []) as unknown[];
        return list.length > 0 ? true : false;
      },
      { label: 'default pipeline provisioning', timeoutMs: 60_000 },
    );

    return projectId;
  }

  async archiveProject(projectId: string): Promise<void> {
    await this.grpc.control
      .archiveProject({ id: projectId, actor_user_id: this.userId }, this.md(projectId))
      .catch(() => undefined);
  }

  async createCompany(
    projectId: string,
    data: { name: string; inn?: string; phone?: string; email?: string },
  ): Promise<string> {
    const res = await this.grpc.company.createCompany(
      {
        project_id: projectId,
        name: data.name,
        inn: data.inn ?? '',
        phone: data.phone ?? '',
        email: data.email ?? '',
        assignee_id: this.userId,
      },
      this.md(projectId),
    );
    return String(res.id ?? '');
  }

  async deleteCompany(projectId: string, companyId: string): Promise<void> {
    await this.grpc.company.deleteCompany({ project_id: projectId, id: companyId }, this.md(projectId));
  }

  async updateCompany(
    projectId: string,
    companyId: string,
    data: Record<string, unknown>,
  ): Promise<void> {
    await this.grpc.company.updateCompany(
      { project_id: projectId, id: companyId, ...data },
      this.md(projectId),
    );
  }

  async mergeCompanies(projectId: string, masterId: string, loserId: string): Promise<void> {
    await this.grpc.company.mergeCompanies(
      {
        project_id: projectId,
        master_id: masterId,
        loser_id: loserId,
        field_decisions: [],
        actor_id: this.userId,
      },
      this.md(projectId),
    );
  }

  async createContact(
    projectId: string,
    data: {
      firstName: string;
      lastName?: string;
      email?: string;
      phone?: string;
      companyIds?: string[];
    },
  ): Promise<string> {
    const res = await this.grpc.contact.createContact(
      {
        project_id: projectId,
        first_name: data.firstName,
        last_name: data.lastName ?? '',
        email: data.email ?? '',
        phone: data.phone ?? '',
        company_ids: data.companyIds ?? [],
        assignee_id: this.userId,
      },
      this.md(projectId),
    );
    return String(res.id ?? '');
  }

  async updateContact(
    projectId: string,
    contactId: string,
    data: { firstName?: string; lastName?: string; phone?: string; email?: string },
  ): Promise<void> {
    await this.grpc.contact.updateContact(
      {
        project_id: projectId,
        id: contactId,
        first_name: data.firstName,
        last_name: data.lastName,
        phone: data.phone,
        email: data.email,
      },
      this.md(projectId),
    );
  }

  async mergeContacts(projectId: string, sourceId: string, targetId: string): Promise<void> {
    await this.grpc.contact.mergeContacts(
      {
        project_id: projectId,
        source_id: sourceId,
        target_id: targetId,
        survivor_fields: [],
      },
      this.md(projectId),
    );
  }

  private async defaultPipelineStage(projectId: string): Promise<{ pipelineId: string; stageId: string }> {
    const res = await this.grpc.pipe.listPipelines({ project_id: projectId }, this.md(projectId));
    const list = (res.list ?? res.pipelines ?? []) as Array<{
      id?: string;
      stages?: Array<{ id?: string }>;
    }>;
    const pipeline = list[0];
    const stageId = pipeline?.stages?.[0]?.id;
    if (!pipeline?.id || !stageId) throw new Error('no pipeline/stage in project');
    return { pipelineId: pipeline.id, stageId };
  }

  async createDeal(projectId: string, data: Record<string, unknown>): Promise<string> {
    const defaults = await this.defaultPipelineStage(projectId);
    const res = await this.grpc.pipe.createDeal(
      {
        project_id: projectId,
        name: data.name ?? 'deal',
        amount: data.amount ?? 0,
        pipeline_id: defaults.pipelineId,
        stage_id: defaults.stageId,
        contact_id: data.contactId ?? data.contact_id ?? '',
        company_id: data.companyId ?? data.company_id ?? '',
        product_id: data.productId ?? data.product_id ?? '',
        assignee_id: data.assigneeId ?? data.assignee_id ?? this.userId,
      },
      this.md(projectId),
    );
    return String(res.id ?? '');
  }

  async updateDeal(projectId: string, dealId: string, data: Record<string, unknown>): Promise<void> {
    await this.grpc.pipe.updateDeal(
      {
        project_id: projectId,
        id: dealId,
        product_id: data.productId ?? data.product_id,
        contact_id: data.contactId ?? data.contact_id,
        company_id: data.companyId ?? data.company_id,
        name: data.name,
      },
      this.md(projectId),
    );
  }

  async closeDeal(projectId: string, dealId: string, result: 'won' | 'lost'): Promise<void> {
    await this.grpc.pipe.closeDeal(
      { project_id: projectId, id: dealId, result },
      this.md(projectId),
    );
  }

  async linkDealContact(
    projectId: string,
    dealId: string,
    contactId: string,
    snapshot: { name: string; phone?: string; email?: string },
  ): Promise<void> {
    await this.grpc.pipe.linkContact(
      {
        project_id: projectId,
        id: dealId,
        contact_id: contactId,
        snapshot: {
          name: snapshot.name,
          phone: snapshot.phone ?? '',
          email: snapshot.email ?? '',
        },
      },
      this.md(projectId),
    );
  }

  async linkDealCompany(
    projectId: string,
    dealId: string,
    companyId: string,
    snapshot: { name: string; inn?: string },
  ): Promise<void> {
    await this.grpc.pipe.linkCompany(
      {
        project_id: projectId,
        id: dealId,
        company_id: companyId,
        snapshot: { name: snapshot.name, inn: snapshot.inn ?? '' },
      },
      this.md(projectId),
    );
  }

  async createProduct(
    projectId: string,
    data: {
      name: string;
      orderTypeId: string;
      price?: number;
      currency?: string;
      unit?: string;
      category?: string;
    },
  ): Promise<string> {
    const res = await this.grpc.product.createProduct(
      {
        project_id: projectId,
        name: data.name,
        order_type_id: data.orderTypeId,
        price: data.price ?? 1000,
        currency: data.currency ?? 'RUB',
        unit: data.unit ?? 'ONE_TIME',
        category: data.category ?? 'default',
        assignee_id: this.userId,
      },
      this.md(projectId),
    );
    return String(res.id ?? '');
  }

  async deleteProduct(
    projectId: string,
    productId: string,
    opts: { force?: boolean } = {},
  ): Promise<void> {
    await this.grpc.product.deleteProduct(
      { project_id: projectId, id: productId, force: opts.force === true },
      this.md(projectId),
    );
  }

  async createOrder(projectId: string, data: Record<string, unknown> = {}): Promise<string> {
    let orderTypeId = data.orderTypeId ?? data.order_type_id;
    if (!orderTypeId) {
      const typeRes = await this.grpc.orders.createOrderType(
        {
          project_id: projectId,
          spec: {
            name: String(data.orderTypeName ?? uniqueBoxName('ord-type')),
            fields: [],
            stages: [
              { id: 's1', name: 'New', order: 0, is_terminal: false },
              { id: 's2', name: 'Done', order: 1, is_terminal: true },
            ],
          },
        },
        this.md(projectId),
      );
      orderTypeId = typeRes.id ?? (typeRes as { spec?: { id?: string } }).spec?.id;
    }
    const res = await this.grpc.orders.createOrder(
      {
        project_id: projectId,
        order_type_id: orderTypeId,
        assignee_id: this.userId,
        notes: String(data.name ?? data.notes ?? uniqueBoxName('order')),
        fields_json: '{}',
      },
      this.md(projectId),
    );
    return String(res.id ?? res.order_id ?? '');
  }

  async createActivity(
    projectId: string,
    data: {
      title: string;
      type?: string;
      links?: Array<{ entityType: string; entityId: string }>;
    },
  ): Promise<string> {
    const res = await this.grpc.activity.createActivity(
      {
        project_id: projectId,
        type: data.type ?? 'task',
        title: data.title,
        status: 'planned',
        assignee_id: this.userId,
        links: (data.links ?? []).map((l) => ({
          entity_type: l.entityType,
          entity_id: l.entityId,
        })),
      },
      this.md(projectId),
    );
    return String(res.id ?? res._id ?? '');
  }

  async createAutomationRule(
    projectId: string,
    data: {
      name: string;
      triggerType: string;
      triggerConfig?: Record<string, unknown>;
      actions: Array<{ id: string; config?: Record<string, unknown> }>;
    },
  ): Promise<string> {
    const res = await this.grpc.automation.createRule(
      {
        project_id: projectId,
        name: data.name,
        enabled: true,
        trigger_type: data.triggerType,
        trigger_config_json: JSON.stringify(data.triggerConfig ?? {}),
        conditions_json: '{}',
        actions_json: JSON.stringify(
          data.actions.map((a) => ({
            type: a.id,
            config: a.config ?? {},
          })),
        ),
        created_by: this.userId,
        can_manage: true,
        enabled_modules: this.modules,
      },
      this.md(projectId),
    );
    return String(res.id ?? '');
  }

  async executeAutomationRule(
    projectId: string,
    ruleId: string,
    payload: Record<string, unknown>,
    source = 'intclosure-money-test',
  ): Promise<Record<string, unknown>> {
    return this.grpc.automation.executeRule(
      {
        project_id: projectId,
        rule_id: ruleId,
        source,
        payload_json: JSON.stringify(payload),
      },
      this.md(projectId),
    );
  }

  async manualRunAutomation(
    projectId: string,
    ruleId: string,
    entityType: string,
    entityId: string,
  ): Promise<Record<string, unknown>> {
    return this.grpc.automation.manualRun(
      {
        project_id: projectId,
        rule_id: ruleId,
        entity_type: entityType,
        entity_id: entityId,
        user_id: this.userId,
      },
      this.md(projectId),
    );
  }

  async hookAutomationEvent(
    projectId: string,
    eventName: string,
    payload: Record<string, unknown>,
  ): Promise<void> {
    await this.grpc.automation.hookEvent(
      {
        project_id: projectId,
        event_name: eventName,
        payload_json: JSON.stringify(payload),
        source: 'intclosure-money-test',
      },
      this.md(projectId),
    );
  }
}

function apiUrl(base: string, path: string): string {
  const root = base.replace(/\/+$/, '');
  const p = path.startsWith('/') ? path : `/${path}`;
  return `${root}${p}`;
}

async function readBody(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return '';
  }
}

export interface LocalGatewaySession {
  token: string;
  userId: string;
  apiBase: string;
  headers(projectId?: string): Record<string, string>;
}

/** Login against local or the box stand gateway REST API. */
export async function loginGatewaySession(
  email: string,
  password: string,
  apiBase = LOCAL_GATEWAY_API_BASE,
  attempts = 4,
): Promise<LocalGatewaySession> {
  let lastStatus = 0;
  let lastText = '';
  for (let i = 0; i < attempts; i++) {
    const res = await fetch(apiUrl(apiBase, '/v1/auth/login'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });
    if (res.ok) {
      const body = (await res.json()) as {
        token?: string;
        user?: { userId?: string; id?: string };
      };
      const token = String(body.token ?? '');
      const userId = String(body.user?.userId ?? body.user?.id ?? '');
      if (!token || !userId) throw new Error('gateway login returned no token/user');
      return {
        token,
        userId,
        apiBase,
        headers(projectId?: string) {
          const h: Record<string, string> = {
            authorization: `Bearer ${token}`,
            'content-type': 'application/json',
          };
          if (projectId) h['x-project-id'] = projectId;
          return h;
        },
      };
    }
    lastStatus = res.status;
    lastText = await readBody(res);
    await new Promise((r) => setTimeout(r, 500 * (i + 1)));
  }
  throw new Error(`gateway login failed after ${attempts} attempts: ${lastStatus} ${lastText}`);
}

export { BOX_GATEWAY_API_BASE, LOCAL_GATEWAY_API_BASE };
