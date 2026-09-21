import { BOX_GATEWAY_API_BASE } from './conn';
import { resolveUserIdByEmail } from './gateway';

type Json = Record<string, unknown>;

function apiUrl(path: string): string {
  const base = BOX_GATEWAY_API_BASE.replace(/\/+$/, '');
  const p = path.startsWith('/') ? path : `/${path}`;
  return `${base}${p}`;
}

async function readBody(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return '';
  }
}

export interface ProvisionedEmployee {
  userId: string;
  email: string;
}

/**
 * Minimal gateway REST client for the box stand integration specs.
 * Creates an isolated test project per suite; never touches foreign projects.
 */
export class BoxGatewayRestClient {
  private constructor(
    readonly token: string,
    readonly userId: string,
    private readonly baseHeaders: Record<string, string>,
  ) {}

  /** Use a pre-authenticated session (e.g. when gateway login is rate-limited). */
  static fromEnvToken(): BoxGatewayRestClient | null {
    const token = process.env.BOX_E2E_TOKEN?.trim();
    const userId = process.env.BOX_E2E_USER_ID?.trim();
    if (!token || !userId) return null;
    return new BoxGatewayRestClient(token, userId, {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
    });
  }

  /** Build from a minted or password-login gateway session. */
  static fromSession(session: { token: string; userId: string }): BoxGatewayRestClient {
    return new BoxGatewayRestClient(session.token, session.userId, {
      authorization: `Bearer ${session.token}`,
      'content-type': 'application/json',
    });
  }

  static async login(
    email = process.env.BOX_E2E_EMAIL ?? 'admin@example.com',
    password = process.env.BOX_E2E_PASSWORD ?? 'admin',
    attempts = 6,
  ): Promise<BoxGatewayRestClient> {
    let lastStatus = 0;
    let lastText = '';
    for (let i = 0; i < attempts; i++) {
      const res = await fetch(apiUrl('/v1/auth/login'), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email, password }),
      });
      if (res.ok) {
        const body = (await res.json()) as { token: string; user: { userId: string } };
        return new BoxGatewayRestClient(body.token, body.user.userId, {
          authorization: `Bearer ${body.token}`,
          'content-type': 'application/json',
        });
      }
      lastStatus = res.status;
      lastText = await readBody(res);
      await new Promise((r) => setTimeout(r, 800 * (i + 1)));
    }
    throw new Error(`box gateway login failed after ${attempts} attempts: ${lastStatus} ${lastText}`);
  }

  private headers(projectId?: string): Record<string, string> {
    const h = { ...this.baseHeaders };
    if (projectId) h['x-project-id'] = projectId;
    return h;
  }

  async createProject(name: string, modules: string[]): Promise<string> {
    const res = await fetch(apiUrl('/v1/projects'), {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify({
        ownerType: 'PERSONAL',
        ownerId: this.userId,
        name,
        templateId: 'blank',
        modules,
      }),
    });
    if (!res.ok) throw new Error(`createProject failed: ${res.status} ${await readBody(res)}`);
    return ((await res.json()) as { id: string }).id;
  }

  async archiveProject(projectId: string): Promise<void> {
    await fetch(apiUrl(`/v1/projects/${projectId}`), {
      method: 'DELETE',
      headers: this.headers(),
    }).catch(() => undefined);
  }

  async requestProjectDeletion(projectId: string, confirmName: string): Promise<void> {
    const res = await fetch(apiUrl(`/v1/projects/${projectId}/request-deletion`), {
      method: 'POST',
      headers: this.headers(projectId),
      body: JSON.stringify({ confirmName }),
    });
    if (!res.ok) {
      throw new Error(`requestProjectDeletion failed: ${res.status} ${await readBody(res)}`);
    }
  }

  async createOrgInvitation(
    email: string,
    projectId: string,
    role = 'employee',
  ): Promise<{ token: string; inviteUrl?: string }> {
    const res = await fetch(apiUrl('/v1/system/invitations'), {
      method: 'POST',
      headers: this.headers(projectId),
      body: JSON.stringify({
        email,
        role,
        projectGrants: [{ projectId, role: 'member' }],
      }),
    });
    if (!res.ok) throw new Error(`createOrgInvitation failed: ${res.status} ${await readBody(res)}`);
    const body = (await res.json()) as { inviteUrl?: string };
    const inviteUrl = body.inviteUrl ?? '';
    const token = decodeURIComponent(inviteUrl.split('/').pop() ?? '');
    if (!token) throw new Error('createOrgInvitation returned no token in inviteUrl');
    return { token, inviteUrl };
  }

  static async acceptOrgInvitation(
    token: string,
    name: string,
    password: string,
  ): Promise<void> {
    const res = await fetch(apiUrl('/v1/invitations/accept'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token, name, password }),
    });
    if (!res.ok) throw new Error(`acceptOrgInvitation failed: ${res.status} ${await readBody(res)}`);
    void (await res.json());
  }

  async findEmployeeUserIdByEmail(email: string): Promise<string> {
    const res = await fetch(apiUrl('/v1/system/employees'), { headers: this.headers() });
    if (!res.ok) throw new Error(`listEmployees failed: ${res.status} ${await readBody(res)}`);
    const list = (await res.json()) as Array<{ userId?: string; email?: string }>;
    const row = list.find((e) => (e.email ?? '').toLowerCase() === email.toLowerCase());
    if (!row?.userId) throw new Error(`employee not found for email ${email}`);
    return row.userId;
  }

  /** Create a fresh org employee with project access — no extra login calls. */
  async provisionOrgEmployee(projectId: string, label: string): Promise<{ userId: string; email: string }> {
    const safe = label.replace(/[^a-z0-9]/gi, '').slice(0, 24) || 'emp';
    const email = `${safe}${Date.now()}@example.com`.toLowerCase();
    const password = `Pw_${Date.now()}_x9!`;
    const { token } = await this.createOrgInvitation(email, projectId);
    await BoxGatewayRestClient.acceptOrgInvitation(token, 'Offboard Emp', password);
    const userId = await resolveUserIdByEmail(email);
    return { userId, email };
  }

  async createContact(
    projectId: string,
    data: {
      first_name: string;
      last_name: string;
      email: string;
      phone?: string;
      assigneeId?: string;
    },
  ): Promise<string> {
    const res = await fetch(`${apiUrl('/v1/contacts')}?projectId=${encodeURIComponent(projectId)}`, {
      method: 'POST',
      headers: this.headers(projectId),
      body: JSON.stringify({
        firstName: data.first_name,
        lastName: data.last_name,
        email: data.email,
        phone: data.phone,
        assigneeId: data.assigneeId,
      }),
    });
    if (!res.ok) throw new Error(`createContact failed: ${res.status} ${await readBody(res)}`);
    const body = (await res.json()) as { id?: string };
    return body.id ?? '';
  }

  async createCompany(
    projectId: string,
    data: { name: string; inn?: string; phone?: string; email?: string; assigneeId?: string },
  ): Promise<string> {
    const res = await fetch(`${apiUrl('/v1/companies')}?projectId=${encodeURIComponent(projectId)}`, {
      method: 'POST',
      headers: this.headers(projectId),
      body: JSON.stringify(data),
    });
    if (!res.ok) throw new Error(`createCompany failed: ${res.status} ${await readBody(res)}`);
    return ((await res.json()) as { id: string }).id;
  }

  async getDefaultPipelineStage(projectId: string): Promise<{ pipelineId: string; stageId: string }> {
    const res = await fetch(`${apiUrl('/v1/pipelines')}?projectId=${encodeURIComponent(projectId)}`, {
      headers: this.headers(projectId),
    });
    if (!res.ok) throw new Error(`get pipelines failed: ${res.status} ${await readBody(res)}`);
    const body = (await res.json()) as
      | Array<{ id: string; stages?: Array<{ id: string }> }>
      | { list?: Array<{ id: string; stages?: Array<{ id: string }> }> };
    const list = Array.isArray(body) ? body : (body.list ?? []);
    const pipeline = list[0];
    const stageId = pipeline?.stages?.[0]?.id;
    if (!pipeline?.id || !stageId) throw new Error('no pipeline/stage in project');
    return { pipelineId: pipeline.id, stageId };
  }

  async createDeal(projectId: string, data: Record<string, unknown>): Promise<string> {
    const defaults = await this.getDefaultPipelineStage(projectId);
    const res = await fetch(`${apiUrl('/v1/deals')}?projectId=${encodeURIComponent(projectId)}`, {
      method: 'POST',
      headers: this.headers(projectId),
      body: JSON.stringify({ amount: 0, ...defaults, ...data }),
    });
    if (!res.ok) throw new Error(`createDeal failed: ${res.status} ${await readBody(res)}`);
    return ((await res.json()) as { id: string }).id;
  }

  async getDefaultOrderTypeId(projectId: string): Promise<string> {
    const res = await fetch(
      `${apiUrl('/v1/order-types')}?projectId=${encodeURIComponent(projectId)}`,
      { headers: this.headers(projectId) },
    );
    if (!res.ok) throw new Error(`list order-types failed: ${res.status} ${await readBody(res)}`);
    const body = (await res.json()) as
      | Array<{ id: string }>
      | { list?: Array<{ id: string }> };
    const list = Array.isArray(body) ? body : (body.list ?? []);
    const id = list[0]?.id;
    if (!id) throw new Error('no order type in project');
    return id;
  }

  async createOrder(
    projectId: string,
    data: Record<string, unknown> & { assigneeId?: string; orderTypeId?: string } = {},
  ): Promise<string> {
    const orderTypeId = data.orderTypeId ?? (await this.getDefaultOrderTypeId(projectId));
    const res = await fetch(`${apiUrl('/v1/orders')}?projectId=${encodeURIComponent(projectId)}`, {
      method: 'POST',
      headers: this.headers(projectId),
      body: JSON.stringify({ orderTypeId, ...data }),
    });
    if (!res.ok) throw new Error(`createOrder failed: ${res.status} ${await readBody(res)}`);
    const body = (await res.json()) as { id?: string; orderId?: string };
    return body.id ?? body.orderId ?? '';
  }

  async createActivity(
    projectId: string,
    data: {
      title: string;
      type?: string;
      assigneeId?: string;
      links?: Array<{ entityType: string; entityId: string }>;
    },
  ): Promise<string> {
    const res = await fetch(`${apiUrl('/v1/activities')}?projectId=${encodeURIComponent(projectId)}`, {
      method: 'POST',
      headers: this.headers(projectId),
      body: JSON.stringify({
        projectId,
        type: data.type ?? 'task',
        title: data.title,
        status: 'planned',
        assigneeId: data.assigneeId ?? this.userId,
        links: data.links,
      }),
    });
    if (!res.ok) throw new Error(`createActivity failed: ${res.status} ${await readBody(res)}`);
    const body = (await res.json()) as { id?: string; _id?: string };
    return body.id ?? body._id ?? '';
  }

  async generateDocument(
    projectId: string,
    data: {
      templateId: string;
      contextType: string;
      recordId: string;
    },
  ): Promise<string> {
    const res = await fetch(`${apiUrl('/v1/documents/generate')}?projectId=${encodeURIComponent(projectId)}`, {
      method: 'POST',
      headers: this.headers(projectId),
      body: JSON.stringify({
        templateId: data.templateId,
        contextType: data.contextType,
        recordId: data.recordId,
      }),
    });
    if (!res.ok) throw new Error(`generateDocument failed: ${res.status} ${await readBody(res)}`);
    const body = (await res.json()) as { groupId?: string; id?: string; group_id?: string };
    return body.groupId ?? body.group_id ?? body.id ?? '';
  }
}
