import { Metadata } from '@grpc/grpc-js';
import {
  BOX_GATEWAY_SERVICE_API_KEY,
  BOX_INTEGRATION_PREFIX,
  BOX_PEER_GRPC,
  BOX_POSTGRES_URI,
  boxUniqueName,
} from './conn';
import { buildGatewayMetadata, type GatewayMetadataContext } from '../metadata';
import { createAuthGrpcClient, createControlGrpcClient } from './grpc-clients';
import { waitFor } from './wait-for';

export function serviceMetadata(projectId?: string): Metadata {
  const md = buildGatewayMetadata({ serviceApiKey: BOX_GATEWAY_SERVICE_API_KEY });
  if (projectId) md.set('x-project-id', projectId);
  return md;
}

export async function resolveSystemAnchorId(): Promise<string> {
  const { Client } = await import('pg');
  const c = new Client({ connectionString: BOX_POSTGRES_URI });
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

/** Secondary auth user for membership / reassignment scenarios (not the primary actor). */
export async function resolveBoxUserEmail(userId: string): Promise<string> {
  const { Client } = await import('pg');
  const c = new Client({ connectionString: BOX_POSTGRES_URI });
  await c.connect();
  try {
    const r = await c.query(`SELECT email FROM auth."User" WHERE id = $1 LIMIT 1`, [userId]);
    const email = r.rows[0]?.email as string | undefined;
    if (!email) throw new Error(`no auth email for user ${userId}`);
    return email;
  } finally {
    await c.end();
  }
}

export async function resolveSecondaryBoxUserId(
  excludeUserId: string,
  email = process.env.BOX_E2E_SECONDARY_EMAIL ?? 'admin@fairflow.local',
): Promise<string> {
  const { Client } = await import('pg');
  const c = new Client({ connectionString: BOX_POSTGRES_URI });
  await c.connect();
  try {
    const byEmail = await c.query(`SELECT id FROM auth."User" WHERE email = $1 LIMIT 1`, [email]);
    const fromEmail = byEmail.rows[0]?.id as string | undefined;
    if (fromEmail && fromEmail !== excludeUserId) return fromEmail;

    const anyOther = await c.query(
      `SELECT id FROM auth."User" WHERE id <> $1 ORDER BY created_at ASC LIMIT 1`,
      [excludeUserId],
    );
    const id = anyOther.rows[0]?.id as string | undefined;
    if (!id) throw new Error('no secondary auth user for box integration');
    return id;
  } finally {
    await c.end();
  }
}

export async function resolveBoxActorUserId(
  email = process.env.BOX_E2E_EMAIL ?? 'admin@example.com',
): Promise<string> {
  const { Client } = await import('pg');
  const c = new Client({ connectionString: BOX_POSTGRES_URI });
  await c.connect();
  try {
    const r = await c.query(`SELECT id FROM auth."User" WHERE email = $1 LIMIT 1`, [email]);
    const id = r.rows[0]?.id as string | undefined;
    if (!id) throw new Error(`no auth user for email ${email}`);
    return id;
  } finally {
    await c.end();
  }
}

/** Create an isolated test project via the box stand control gRPC (no gateway login). */
export async function createBoxTestProjectViaControl(
  modules: string[] = ['deals', 'contacts', 'orders', 'documents', 'automation', 'notifications'],
  actorUserId?: string,
): Promise<string> {
  const control = createControlGrpcClient(BOX_PEER_GRPC.control);
  const ownerId = await resolveSystemAnchorId();
  const actor = actorUserId ?? (await resolveBoxActorUserId());
  const md = serviceMetadata();
  md.set('x-user-id', actor);
  const r = await control.project.createProject(
    {
      owner_id: ownerId,
      name: boxUniqueName('proj'),
      template_id: 'blank',
      modules,
      created_by_user_id: actor,
    },
    md,
  );
  const id = String(r.id ?? r.project_id ?? '');
  if (!id) throw new Error('createBoxTestProjectViaControl returned no project id');
  return id;
}

/** Archive a project via the box stand control gRPC (best-effort teardown). */
export async function archiveBoxTestProjectViaControl(
  projectId: string,
  actorUserId?: string,
): Promise<void> {
  const control = createControlGrpcClient(BOX_PEER_GRPC.control);
  const actor = actorUserId ?? (await resolveBoxActorUserId());
  const md = serviceMetadata(projectId);
  md.set('x-user-id', actor);
  await control.project.archiveProject({ project_id: projectId, actor_user_id: actor }, md);
}

export function gatewayMetadataCtx(projectId: string, userId: string): GatewayMetadataContext {
  return { projectId, userId };
}

/** Poll control ListMembers until `userId` is visible (notification fan-out gate). */
export async function waitForProjectMemberListed(
  projectId: string,
  userId: string,
  actorUserId: string,
  timeoutMs = 30_000,
): Promise<void> {
  const control = createControlGrpcClient(BOX_PEER_GRPC.control);
  const md = serviceMetadata(projectId);
  md.set('x-user-id', actorUserId);
  await waitFor(
    async () => {
      const res = await control.project.listMembers({ project_id: projectId }, md);
      const list = (res.list ?? res.members ?? []) as Array<Record<string, unknown>>;
      const found = list.some((m) => String(m.user_id ?? m.userId ?? m.id ?? '') === userId);
      return found ? true : false;
    },
    { label: `control ListMembers includes ${userId}`, timeoutMs },
  );
}

/** Current UTC month key — matches billing {@link ModuleSubscriptionService.incrementUsage}. */
export function currentBillingPeriodKey(): string {
  const now = new Date();
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
}

/** Latest published control outbox row for a project-scoped routing key. */
export async function findControlOutboxEvent(
  projectId: string,
  routingKey: string,
  sinceMs?: number,
): Promise<Record<string, unknown> | null> {
  const { Client } = await import('pg');
  const c = new Client({ connectionString: BOX_POSTGRES_URI });
  await c.connect();
  try {
    const params: unknown[] = [projectId, routingKey];
    let sql = `SELECT message_id, routing_key, status, envelope, created_at
               FROM control."ControlOutbox"
               WHERE project_id = $1 AND routing_key = $2 AND status = 'published'`;
    if (sinceMs) {
      sql += ` AND EXTRACT(EPOCH FROM created_at) * 1000 >= $3`;
      params.push(sinceMs);
    }
    sql += ` ORDER BY created_at DESC LIMIT 1`;
    const r = await c.query(sql, params);
    return (r.rows[0] as Record<string, unknown> | undefined) ?? null;
  } finally {
    await c.end();
  }
}

/** Read billing.quota_usage.used for a project action (e.g. `automation:automation.run`). */
export async function readBillingQuotaUsage(
  projectId: string,
  action: string,
  periodKey = currentBillingPeriodKey(),
): Promise<number> {
  const { Client } = await import('pg');
  const c = new Client({ connectionString: BOX_POSTGRES_URI });
  await c.connect();
  try {
    const r = await c.query(
      `SELECT used FROM billing.quota_usage
       WHERE project_id = $1 AND action = $2 AND period_key = $3
       LIMIT 1`,
      [projectId, action, periodKey],
    );
    const raw = r.rows[0]?.used;
    if (raw == null) return 0;
    return Number(raw);
  } finally {
    await c.end();
  }
}

export interface BoxTestUser {
  userId: string;
  email: string;
  password: string;
}

/** Provision an isolated auth user on the box stand (idempotent by unique email). */
export async function provisionBoxTestUser(
  label = 'gw-user',
  password = `Intclosure-${Date.now()}-9x`,
): Promise<BoxTestUser> {
  const email = `${BOX_INTEGRATION_PREFIX}${label}-${Date.now()}-${Math.floor(Math.random() * 1e4)}@example.com`.toLowerCase();
  const auth = createAuthGrpcClient();
  try {
    const res = await auth.provisionUser(
      { email, name: boxUniqueName(label), password },
      serviceMetadata(),
    );
    const user = (res.user ?? res) as Record<string, unknown>;
    const userId = String(user.id ?? user.user_id ?? '');
    if (!userId) throw new Error('provisionBoxTestUser returned no user id');
    return { userId, email, password };
  } finally {
    auth.close();
  }
}
