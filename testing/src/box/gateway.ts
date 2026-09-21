import { BOX_CONN, boxUniqueName } from './env';
import { buildServiceMetadata } from '../metadata';

/** Encode a plain map as google.protobuf.Struct wire shape for raw @grpc/grpc-js clients. */
function jsonToGrpcStruct(value: Record<string, unknown>): {
  fields: Record<string, unknown>;
} {
  const fields: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) {
    if (typeof v === 'string') fields[k] = { stringValue: v };
    else if (typeof v === 'boolean') fields[k] = { boolValue: v };
    else if (typeof v === 'number' && Number.isFinite(v))
      fields[k] = { numberValue: v };
  }
  return { fields };
}

/** Module settings sent as plain maps are silently dropped on the wire — encode Struct. */
function encodeModuleConfigsForGrpc(
  configs?: Array<Record<string, unknown>>,
): Array<Record<string, unknown>> | undefined {
  if (!configs) return undefined;
  return configs.map((cfg) => {
    const out: Record<string, unknown> = { ...cfg };
    const integration = cfg.integration_settings ?? cfg.integrationSettings;
    if (
      integration &&
      typeof integration === 'object' &&
      !Array.isArray(integration) &&
      !('fields' in integration)
    ) {
      out.integration_settings = jsonToGrpcStruct(
        integration as Record<string, unknown>,
      );
    }
    const personal = cfg.personal_settings ?? cfg.personalSettings;
    if (
      personal &&
      typeof personal === 'object' &&
      !Array.isArray(personal) &&
      !('fields' in personal)
    ) {
      out.personal_settings = jsonToGrpcStruct(
        personal as Record<string, unknown>,
      );
    }
    return out;
  });
}

export interface BoxGatewaySession {
  token: string;
  userId: string;
  apiBase: string;
}

export interface BoxAuthUserRow {
  id: string;
  login: string;
  email: string;
}

async function gatewayFetch(
  path: string,
  init: RequestInit & { token?: string; projectId?: string } = {},
): Promise<Response> {
  const headers: Record<string, string> = {
    ...(init.headers as Record<string, string>),
  };
  if (init.token) headers.Authorization = `Bearer ${init.token}`;
  if (init.projectId) headers['X-Project-Id'] = init.projectId;
  const url = `${BOX_CONN.gatewayHttp}/api${path.startsWith('/') ? path : `/${path}`}`;
  return fetch(url, { ...init, headers });
}

/** Login to the box stand gateway (real HTTP). */
export async function loginBoxGateway(
  email = process.env.BOX_E2E_EMAIL ?? 'admin@fairflow.local',
  password = process.env.BOX_E2E_PASSWORD ?? 'admin',
): Promise<BoxGatewaySession> {
  const apiBase = `${BOX_CONN.gatewayHttp}/api`;
  let last: Response | undefined;
  for (let i = 0; i < 4; i++) {
    last = await gatewayFetch('/v1/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });
    if (last.ok) break;
    await new Promise((r) => setTimeout(r, 400 * (i + 1)));
  }
  if (!last?.ok) {
    throw new Error(`box gateway login failed: ${last?.status} ${await last?.text()}`);
  }
  const body = (await last.json()) as { token: string; user: { userId: string } };
  return { token: body.token, userId: body.user.userId, apiBase };
}

/** Resolve system anchor id from control Postgres (owner_id for CreateProject). */
export async function resolveSystemAnchorId(): Promise<string> {
  const { Client } = await import('pg');
  const c = new Client({ connectionString: BOX_CONN.postgres });
  await c.connect();
  try {
    const r = await c.query(
      `SELECT id FROM control.system_settings WHERE is_active = true ORDER BY created_at ASC LIMIT 1`,
    );
    const id = r.rows[0]?.id as string | undefined;
    if (!id) throw new Error('no active SystemSettings row in control schema');
    return id;
  } finally {
    await c.end();
  }
}

/** Resolve the platform admin row (read-only) for JWT minting when password login is unavailable. */
export async function resolveBoxPlatformUser(): Promise<BoxAuthUserRow> {
  const { Client } = await import('pg');
  const c = new Client({ connectionString: BOX_CONN.postgres });
  await c.connect();
  try {
    const r = await c.query(
      `SELECT id, login, email FROM auth."User" WHERE is_active = true ORDER BY created_at ASC LIMIT 1`,
    );
    const row = r.rows[0] as BoxAuthUserRow | undefined;
    if (!row?.id) throw new Error('no active auth user in the box stand postgres');
    return row;
  } finally {
    await c.end();
  }
}

export function mintBoxAccessTokenForUser(
  user: Pick<BoxAuthUserRow, 'id' | 'login' | 'email'>,
): string {
  const jwt = require('jsonwebtoken') as typeof import('jsonwebtoken');
  const prefix = process.env.BOX_DATA_PREFIX ?? 'intclosure-bff-';
  const jti = `${prefix}jwt-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  return jwt.sign(
    {
      sub: user.id,
      jti,
      login: user.login,
      email: user.email,
    },
    BOX_CONN.jwtSecret,
    { expiresIn: '24h' },
  );
}

/**
 * Obtain a gateway session: password login when BOX_E2E_* is set, otherwise mint a
 * JWT for the platform admin using the shared JWT_SECRET (session deny-list off in tests).
 */
export async function resolveBoxTestSession(
  email = process.env.BOX_E2E_EMAIL,
  password = process.env.BOX_E2E_PASSWORD,
): Promise<BoxGatewaySession> {
  if (email && password) {
    return loginBoxGateway(email, password);
  }
  const user = await resolveBoxPlatformUser();
  const token = mintBoxAccessTokenForUser(user);
  return { token, userId: user.id, apiBase: `${BOX_CONN.gatewayHttp}/api` };
}

/** Create an isolated test project via the box stand gateway (data-isolation rule). */
export async function createBoxTestProject(
  session: BoxGatewaySession,
  modules: string[] = [
    'deals',
    'contacts',
    'companies',
    'orders',
    'products',
    'documents',
    'activities',
    'automation',
    'reports',
    'statistics',
    'search',
    'notifications',
    'chat',
  ],
  templateId = 'blank',
): Promise<string> {
  const res = await gatewayFetch('/v1/projects', {
    method: 'POST',
    token: session.token,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      ownerType: 'PERSONAL',
      ownerId: session.userId,
      name: boxUniqueName('proj'),
      templateId,
      modules,
    }),
  });
  if (!res.ok) {
    throw new Error(`createBoxTestProject failed: ${res.status} ${await res.text()}`);
  }
  return ((await res.json()) as { id: string }).id;
}

/** Soft-archive a project (best-effort teardown). */
export async function archiveBoxTestProject(
  session: BoxGatewaySession,
  projectId: string,
): Promise<void> {
  await gatewayFetch(`/v1/projects/${projectId}`, {
    method: 'DELETE',
    token: session.token,
  });
}

/** Platform admin email (read-only) for auth transactional-email integration probes. */
export async function resolveBoxPlatformUserEmail(): Promise<string> {
  const user = await resolveBoxPlatformUser();
  return user.email;
}

/** Create an isolated test project via local gateway HTTP (data-isolation rule). */
export async function createBoxTestProjectViaLocalGateway(
  apiBase: string,
  session: BoxGatewaySession,
  modules: string[] = [
    'deals',
    'contacts',
    'orders',
    'documents',
    'automation',
  ],
): Promise<string> {
  const { localGatewayFetch } = await import('./http');
  const res = await localGatewayFetch(apiBase, '/v1/projects', {
    method: 'POST',
    token: session.token,
    body: {
      ownerType: 'PERSONAL',
      ownerId: session.userId,
      name: boxUniqueName('proj'),
      templateId: 'blank',
      modules,
    },
  });
  if (!res.ok) {
    throw new Error(
      `createBoxTestProjectViaLocalGateway failed: ${res.status} ${await res.text()}`,
    );
  }
  return ((await res.json()) as { id: string }).id;
}

/** Soft-archive a project via local gateway HTTP (best-effort teardown). */
export async function archiveBoxTestProjectViaLocalGateway(
  apiBase: string,
  session: BoxGatewaySession,
  projectId: string,
): Promise<void> {
  const { localGatewayFetch } = await import('./http');
  await localGatewayFetch(apiBase, `/v1/projects/${projectId}`, {
    method: 'DELETE',
    token: session.token,
  });
}

/** Resolve a platform user id for actor-scoped control RPCs (no gateway login). */
export async function resolveBoxActorUserId(
  email = process.env.BOX_E2E_EMAIL ?? 'admin@example.com',
): Promise<string> {
  const { Client } = await import('pg');
  const c = new Client({ connectionString: BOX_CONN.postgres });
  await c.connect();
  try {
    const r = await c.query(
      `SELECT id FROM auth."User" WHERE email = $1 LIMIT 1`,
      [email],
    );
    const id = r.rows[0]?.id as string | undefined;
    if (!id) throw new Error(`no auth user for email ${email}`);
    return id;
  } finally {
    await c.end();
  }
}

export interface LocalControlHarnessLike {
  grpc: {
    project: {
      createProject: (
        req: Record<string, unknown>,
        md?: import('@grpc/grpc-js').Metadata,
      ) => Promise<Record<string, unknown>>;
      archiveProject: (
        req: Record<string, unknown>,
        md?: import('@grpc/grpc-js').Metadata,
      ) => Promise<Record<string, unknown>>;
    };
  };
}

/** Create an isolated test project via local control gRPC (data-isolation rule). */
export async function createBoxTestProjectViaControl(
  harness: LocalControlHarnessLike,
  modules: string[] = [
    'deals',
    'contacts',
    'orders',
    'documents',
    'automation',
  ],
  actorUserId?: string,
  moduleConfigs?: Array<Record<string, unknown>>,
  templateId = 'blank',
): Promise<string> {
  const ownerId = await resolveSystemAnchorId();
  const actor = actorUserId ?? (await resolveBoxActorUserId());
  const md = serviceMetadata();
  md.set('x-user-id', actor);
  const req: Record<string, unknown> = {
    owner_id: ownerId,
    name: boxUniqueName('proj'),
    template_id: templateId,
    modules,
    created_by_user_id: actor,
  };
  if (moduleConfigs)
    req.module_configs = encodeModuleConfigsForGrpc(moduleConfigs);
  const r = await harness.grpc.project.createProject(req, md);
  const id = String(r.id ?? r.project_id ?? '');
  if (!id)
    throw new Error('createBoxTestProjectViaControl returned no project id');
  return id;
}

/** Archive a project via local control gRPC (best-effort teardown). */
export async function archiveBoxTestProjectViaControl(
  harness: LocalControlHarnessLike,
  projectId: string,
  actorUserId?: string,
): Promise<void> {
  const actor = actorUserId ?? (await resolveBoxActorUserId());
  const md = serviceMetadata(projectId);
  md.set('x-user-id', actor);
  await harness.grpc.project.archiveProject(
    { id: projectId, actor_user_id: actor },
    md,
  );
}

export async function resolveUserIdByEmail(email: string): Promise<string> {
  const { Client } = await import('pg');
  const c = new Client({ connectionString: BOX_CONN.postgres });
  await c.connect();
  try {
    const r = await c.query(`SELECT id FROM auth."User" WHERE lower(email) = lower($1) LIMIT 1`, [
      email,
    ]);
    const id = r.rows[0]?.id as string | undefined;
    if (!id) throw new Error(`no auth user for email ${email}`);
    return id;
  } finally {
    await c.end();
  }
}

export function serviceMetadata(projectId?: string) {
  const md = buildServiceMetadata(BOX_CONN.gatewayServiceApiKey);
  if (projectId) md.set('x-project-id', projectId);
  return md;
}
