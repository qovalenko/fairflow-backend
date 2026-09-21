import type { Metadata } from '@grpc/grpc-js';
import { BOX_CONN, boxUniqueName } from './env';
import { BoxGatewayRestClient } from './gateway-rest-client';
import { BoxPostgresHelper } from './box-postgres';
import { BoxMongoReader } from './box-mongo';
import {
  createAuthDirectoryGrpcClient,
  createAuthGrpcClient,
  createCompanyGrpcClient,
  createContactGrpcClient,
  createDocumentsGrpcClient,
  createOrdersGrpcClient as createPeerOrdersGrpcClient,
  createPipeGrpcClient,
  type ControlGrpcClients,
} from './grpc';
import {
  archiveBoxTestProjectViaControl,
  createBoxTestProjectViaControl,
  resolveBoxActorUserId,
  resolveBoxTestSession,
  resolveSystemAnchorId,
  serviceMetadata,
  type LocalControlHarnessLike,
} from './gateway';
import { waitFor } from './wait-for';
import { startLocalControlApp, type LocalControlHarness } from './control-app';
import { buildServiceOutboundMetadata } from '@fairflow/shared';
import {
  BoxRabbitHelper,
  assertPeerQueueWired,
  formatPeerQueueProbe,
  type BoxQueueProbe,
} from './box-rabbit';

export const OFFBOARD_MODULES = [
  'contacts',
  'companies',
  'deals',
  'orders',
  'activities',
  'documents',
  'search',
] as const;

export interface OffboardFixture {
  projectId: string;
  projectName: string;
  employee: { userId: string; email: string };
  actorUserId: string;
}

/** Minted JWT gateway client for org invitations (avoids password login rate limits). */
export async function createBoxGatewayClient(): Promise<BoxGatewayRestClient> {
  const session = await resolveBoxTestSession();
  return BoxGatewayRestClient.fromSession(session);
}

/** Create an isolated project and wait for the box stand pipe provisioning. */
export async function createOffboardTestProject(
  harness: LocalControlHarness,
  actorUserId: string,
  label: string,
  modules: readonly string[] = OFFBOARD_MODULES,
): Promise<{ projectId: string; projectName: string }> {
  const projectName = boxUniqueName(label);
  const projectId = await createBoxTestProjectViaControl(
    harness,
    [...modules],
    actorUserId,
  );
  const md = serviceMetadata(projectId);
  const pipe = createPipeGrpcClient(BOX_CONN.grpc.pipe);
  if (modules.includes('deals')) {
    await waitFor(
      async () => {
        const r = await pipe.listPipelines({ project_id: projectId }, md);
        const list = (r.list ?? r.pipelines ?? []) as unknown[];
        return list.length > 0 ? true : false;
      },
      { label: 'default pipeline on the box stand', timeoutMs: 45_000 },
    );
  }
  if (modules.includes('orders')) {
    await ensureOrdersProvisioned(projectId);
  }
  const got = await harness.grpc.project.getProject({ id: projectId }, md);
  return { projectId, projectName: String(got.name ?? projectName) };
}

/** Seed default order types on the box stand orders (sync gRPC). */
export async function ensureOrdersProvisioned(projectId: string): Promise<void> {
  const orders = createPeerOrdersGrpcClient(BOX_CONN.grpc.orders);
  const md = serviceMetadata(projectId);
  await orders.provisionDefaults({ project_id: projectId, template_id: 'b2b-sales' }, md);
  await waitFor(
    async () => {
      const r = await orders.listOrderTypes({ project_id: projectId }, md);
      const list = (r.list ?? r.order_types ?? r.orderTypes ?? []) as unknown[];
      return list.length > 0 ? true : false;
    },
    { label: 'order types after ProvisionDefaults', timeoutMs: 30_000 },
  );
}

/** Seed published document templates on the box stand documents (sync gRPC). */
export async function ensureDocumentsProvisioned(
  projectId: string,
  enabledModules: readonly string[],
): Promise<void> {
  const documents = createDocumentsGrpcClient(BOX_CONN.grpc.documents);
  const md = serviceMetadata(projectId);
  await documents.provisionDefaults(
    { project_id: projectId, enabled_modules: [...enabledModules] },
    md,
  );
  await waitFor(
    async () => {
      const r = await documents.listTemplates({ project_id: projectId }, md);
      const list = (r.list ?? r.templates ?? []) as unknown[];
      return list.length > 0 ? true : false;
    },
    { label: 'document templates after ProvisionDefaults', timeoutMs: 60_000 },
  );
}

/** Wait until the box stand auth UserDirectory resolves the user (after ProvisionUser). */
export async function waitForAuthUserResolvable(
  userId: string,
  timeoutMs = 30_000,
): Promise<void> {
  const directory = createAuthDirectoryGrpcClient(BOX_CONN.grpc.auth);
  const md = buildServiceOutboundMetadata({ serviceApiKey: BOX_CONN.gatewayServiceApiKey });
  await waitFor(
    async () => {
      const r = await directory.resolveUsers({ ids: [userId] }, md);
      const users = (r.users ?? []) as Array<{ id?: string }>;
      return users.some((u) => u.id === userId) ? true : false;
    },
    { label: `auth directory resolves ${userId}`, timeoutMs },
  );
}

/** Create an auth user row on the box stand via auth ProvisionUser (directory-visible). */
export async function createBoxAuthUser(label: string): Promise<{ userId: string; email: string }> {
  const email = `${boxUniqueName(label)}@example.com`.toLowerCase();
  const password = `Pw_${Date.now()}_x9!`;
  const auth = createAuthGrpcClient(BOX_CONN.grpc.auth);
  const md = buildServiceOutboundMetadata({ serviceApiKey: BOX_CONN.gatewayServiceApiKey });
  const res = await auth.provisionUser({ email, name: 'Offboard Emp', password }, md);
  const user = (res.user ?? {}) as { id?: string; email?: string };
  const userId = String(user.id ?? '');
  if (!userId) throw new Error('auth ProvisionUser returned no user id');
  await waitForAuthUserResolvable(userId);
  return { userId, email: String(user.email ?? email) };
}

/** Seed control.employee directly (bypasses AddEmployee directory gate on local control). */
export async function seedControlOrgEmployee(
  userId: string,
  role = 'employee',
): Promise<void> {
  const { Client } = await import('pg');
  const { newEntityId } = await import('@fairflow/shared');
  const organizationId = await resolveSystemAnchorId();
  const c = new Client({ connectionString: BOX_CONN.postgres });
  await c.connect();
  try {
    await c.query(
      `INSERT INTO control."Employee" (
         id, organization_id, user_id, role, is_active, created_at, updated_at
       ) VALUES ($1, $2, $3, $4, true, NOW(), NOW())
       ON CONFLICT (organization_id, user_id) DO UPDATE
         SET is_active = true, role = EXCLUDED.role, updated_at = NOW()`,
      [newEntityId(), organizationId, userId, role],
    );
  } finally {
    await c.end();
  }
}

/**
 * Provision a fresh org employee with project membership via local control gRPC
 * (avoids gateway invitation rate limits on the box stand).
 */
export async function provisionOffboardEmployee(
  harness: LocalControlHarness,
  projectId: string,
  actorUserId: string,
  label: string,
): Promise<{ userId: string; email: string }> {
  const employee = await createBoxAuthUser(label);
  await seedControlOrgEmployee(employee.userId);
  const md = serviceMetadata(projectId);
  md.set('x-user-id', actorUserId);
  await harness.grpc.project.addMember(
    {
      project_id: projectId,
      user_id: employee.userId,
      role: 'member',
      actor_user_id: actorUserId,
    },
    md,
  );
  return employee;
}

/** Create a contact owned by `ownerUserId` via the box stand contact gRPC (assignee_id → ownerId). */
export async function createBoxOwnedContact(
  projectId: string,
  ownerUserId: string,
  actorUserId: string,
  label: string,
): Promise<string> {
  const contact = createContactGrpcClient(BOX_CONN.grpc.contact);
  const md = serviceMetadata(projectId);
  md.set('x-user-id', actorUserId);
  const res = await contact.createContact(
    {
      project_id: projectId,
      first_name: 'Off',
      last_name: 'Board',
      email: `${boxUniqueName(label)}@example.com`.toLowerCase(),
      assignee_id: ownerUserId,
    },
    md,
  );
  const id = String(res.id ?? (res.contact as { id?: string })?.id ?? '');
  if (!id) throw new Error('createBoxOwnedContact returned no id');
  return id;
}

/** Create a company owned by `ownerUserId` via the box stand company gRPC (assignee_id → ownerId). */
export async function createBoxOwnedCompany(
  projectId: string,
  ownerUserId: string,
  actorUserId: string,
  label: string,
): Promise<string> {
  const company = createCompanyGrpcClient(BOX_CONN.grpc.company);
  const md = serviceMetadata(projectId);
  md.set('x-user-id', actorUserId);
  const res = await company.createCompany(
    {
      project_id: projectId,
      name: boxUniqueName(label),
      inn: '7700000201',
      assignee_id: ownerUserId,
    },
    md,
  );
  const id = String(res.id ?? (res.company as { id?: string })?.id ?? '');
  if (!id) throw new Error('createBoxOwnedCompany returned no id');
  return id;
}

/** Poll gateway until default order types exist. */
export async function waitForDefaultOrderType(
  gateway: BoxGatewayRestClient,
  projectId: string,
  timeoutMs = 30_000,
): Promise<string> {
  return waitFor(
    async () => {
      try {
        const id = await gateway.getDefaultOrderTypeId(projectId);
        return id || false;
      } catch {
        return false;
      }
    },
    { label: 'default order type via gateway', timeoutMs },
  );
}

export async function setupOffboardFixture(
  harness: LocalControlHarness,
  gateway: BoxGatewayRestClient,
  label: string,
  modules: readonly string[] = OFFBOARD_MODULES,
): Promise<OffboardFixture> {
  const actorUserId = await resolveBoxActorUserId();
  const { projectId, projectName } = await createOffboardTestProject(
    harness,
    actorUserId,
    label,
    modules,
  );
  const employee = await provisionOffboardEmployee(harness, projectId, actorUserId, `${label}-emp`);
  return { projectId, projectName, employee, actorUserId };
}

export async function waitForControlOutboxPublished(
  postgres: BoxPostgresHelper,
  routingKey: string,
  projectId: string,
  timeoutMs = 45_000,
): Promise<void> {
  await waitFor(
    async () => ((await postgres.hasPublishedOutbox(routingKey, projectId)) ? true : false),
    { label: `outbox ${routingKey} published for ${projectId}`, timeoutMs },
  );
}

/** Probe one member-offboard peer queue on the box stand (read-only wiring diagnosis). */
export async function probeMemberOffboardPeerQueue(
  peerQueueBase: string,
): Promise<BoxQueueProbe> {
  const rabbit = await BoxRabbitHelper.connect();
  try {
    return await rabbit.probeQueue(peerQueueBase);
  } finally {
    await rabbit.close();
  }
}

/** Probe all member-offboard peer queues (catalog #45–#49). */
export async function probeAllMemberOffboardPeerQueues(): Promise<BoxQueueProbe[]> {
  const rabbit = await BoxRabbitHelper.connect();
  try {
    return await rabbit.probeMemberOffboardPeers();
  } finally {
    await rabbit.close();
  }
}

/**
 * After control published `control.member.offboarded`, assert the target peer consumer
 * is wired on the box stand. Throws with queue stats when the edge cannot work yet.
 */
export async function assertMemberOffboardPeerWired(peerQueueBase: string): Promise<BoxQueueProbe> {
  const probe = await probeMemberOffboardPeerQueue(peerQueueBase);
  assertPeerQueueWired(peerQueueBase, probe);
  return probe;
}

/** Format all member-offboard peer probes for bug reports. */
export async function formatMemberOffboardPeerProbeReport(): Promise<string> {
  const probes = await probeAllMemberOffboardPeerQueues();
  return formatPeerQueueProbe(probes);
}

/** Probe one project-purge peer queue on the box stand (read-only wiring diagnosis). */
export async function probeProjectPurgePeerQueue(
  peerQueueBase: string,
): Promise<BoxQueueProbe> {
  const rabbit = await BoxRabbitHelper.connect();
  try {
    return await rabbit.probeQueue(peerQueueBase);
  } finally {
    await rabbit.close();
  }
}

/** Probe all project-purge peer queues (catalog #50). */
export async function probeAllProjectPurgePeerQueues(): Promise<BoxQueueProbe[]> {
  const rabbit = await BoxRabbitHelper.connect();
  try {
    return await rabbit.probeProjectPurgePeers();
  } finally {
    await rabbit.close();
  }
}

/**
 * After control published `control.project.purged`, assert the target peer consumer
 * is wired on the box stand. Throws with queue stats when the edge cannot work yet.
 */
export async function assertProjectPurgePeerWired(peerQueueBase: string): Promise<BoxQueueProbe> {
  const probe = await probeProjectPurgePeerQueue(peerQueueBase);
  assertPeerQueueWired(peerQueueBase, probe);
  return probe;
}

/** Format all project-purge peer probes for bug reports. */
export async function formatProjectPurgePeerProbeReport(): Promise<string> {
  const probes = await probeAllProjectPurgePeerQueues();
  return formatPeerQueueProbe(probes);
}

function baselineMessageCount(probe: BoxQueueProbe): number {
  return 'notFound' in probe ? 0 : probe.messageCount;
}

/**
 * After control published `control.member.offboarded`, wait for a delivery signal on the
 * peer work-queue: backlog growth when consumers=0, or a wired consumer when consumers≥1.
 */
export async function waitForMemberOffboardPeerQueueDelivery(
  peerQueueBase: string,
  beforeProbe: BoxQueueProbe,
  timeoutMs = 45_000,
): Promise<BoxQueueProbe> {
  const baseline = baselineMessageCount(beforeProbe);
  const beforeMissing = 'notFound' in beforeProbe;
  return waitFor(
    async () => {
      const probe = await probeMemberOffboardPeerQueue(peerQueueBase);
      if ('notFound' in probe) {
        return beforeMissing ? false : probe;
      }
      if (beforeMissing) {
        return probe.messageCount >= 1 || probe.consumerCount > 0 ? probe : false;
      }
      if (probe.consumerCount > 0) {
        return probe.messageCount <= baseline + 1 ? probe : false;
      }
      return probe.messageCount > baseline ? probe : false;
    },
    { label: `member-offboard delivery on ${peerQueueBase}`, timeoutMs },
  );
}

/**
 * After control published `control.project.purged`, wait for a delivery signal on the
 * peer purge work-queue (same semantics as member-offboard).
 */
export async function waitForProjectPurgePeerQueueDelivery(
  peerQueueBase: string,
  beforeProbe: BoxQueueProbe,
  timeoutMs = 45_000,
): Promise<BoxQueueProbe> {
  const baseline = baselineMessageCount(beforeProbe);
  const beforeMissing = 'notFound' in beforeProbe;
  return waitFor(
    async () => {
      const probe = await probeProjectPurgePeerQueue(peerQueueBase);
      if ('notFound' in probe) {
        return beforeMissing ? false : probe;
      }
      if (beforeMissing) {
        return probe.messageCount >= 1 || probe.consumerCount > 0 ? probe : false;
      }
      if (probe.consumerCount > 0) {
        return probe.messageCount <= baseline + 1 ? probe : false;
      }
      return probe.messageCount > baseline ? probe : false;
    },
    { label: `project-purge delivery on ${peerQueueBase}`, timeoutMs },
  );
}

/** Assert control published a valid `control.member.offboarded` envelope (peer diagnosis). */
export async function assertMemberOffboardEventPublished(
  postgres: BoxPostgresHelper,
  projectId: string,
  departingUserId: string,
  reassignToUserId: string,
): Promise<void> {
  const envelope = await postgres.getLatestPublishedOutboxEnvelope(
    'control.member.offboarded',
    projectId,
  );
  if (!envelope) {
    throw new Error(`control.member.offboarded not published for project ${projectId}`);
  }
  if (envelope.type !== 'control.member.offboarded') {
    throw new Error(`expected control.member.offboarded, got ${String(envelope.type)}`);
  }
  if (envelope.projectId !== projectId) {
    throw new Error(
      `envelope projectId mismatch: expected ${projectId}, got ${String(envelope.projectId)}`,
    );
  }
  const payload = (envelope.payload ?? {}) as Record<string, unknown>;
  const meta = (payload.metadata ?? {}) as Record<string, unknown>;
  if (meta.departingUserId !== departingUserId) {
    throw new Error(
      `metadata.departingUserId mismatch: expected ${departingUserId}, got ${String(meta.departingUserId)}`,
    );
  }
  if (meta.reassignToUserId !== reassignToUserId) {
    throw new Error(
      `metadata.reassignToUserId mismatch: expected ${reassignToUserId}, got ${String(meta.reassignToUserId)}`,
    );
  }
  const offboardTs = Number(meta.offboardTs);
  if (!Number.isFinite(offboardTs) || offboardTs <= 0) {
    throw new Error(`metadata.offboardTs invalid: ${String(meta.offboardTs)}`);
  }
}

export async function deactivateMember(
  harness: { grpc: Pick<ControlGrpcClients, 'organization'> },
  leaverUserId: string,
  reassignToUserId: string,
  actorUserId: string,
  projectId?: string,
  postgres?: BoxPostgresHelper,
): Promise<void> {
  const md = serviceMetadata(projectId);
  md.set('x-user-id', actorUserId);
  await harness.grpc.organization.deactivateEmployee(
    {
      user_id: leaverUserId,
      actor_user_id: actorUserId,
      reassign_to_user_id: reassignToUserId,
    },
    md,
  );
  if (postgres && projectId) {
    await waitForControlOutboxPublished(postgres, 'control.member.offboarded', projectId);
    await assertMemberOffboardEventPublished(
      postgres,
      projectId,
      leaverUserId,
      reassignToUserId,
    );
  }
}

export async function requestProjectPurge(
  harness: LocalControlHarnessLike & {
    grpc: Pick<ControlGrpcClients, 'project'>;
  },
  postgres: BoxPostgresHelper,
  projectId: string,
  projectName: string,
  actorUserId: string,
): Promise<void> {
  const md = serviceMetadata(projectId);
  md.set('x-user-id', actorUserId);
  await harness.grpc.project.requestProjectDeletion(
    {
      id: projectId,
      confirm_name: projectName,
      actor_user_id: actorUserId,
    },
    md,
  );
  await postgres.fastForwardProjectDeletion(projectId);
  await waitFor(
    async () => (await postgres.getProjectStatus(projectId)) === 'purged',
    { label: 'project status purged', timeoutMs: 90_000 },
  );
  await waitForControlOutboxPublished(postgres, 'control.project.purged', projectId);
  await assertProjectPurgedEventPublished(postgres, projectId);
}

/** Assert control published a valid `control.project.purged` envelope (peer diagnosis). */
export async function assertProjectPurgedEventPublished(
  postgres: BoxPostgresHelper,
  projectId: string,
): Promise<void> {
  const envelope = await postgres.getLatestPublishedOutboxEnvelope(
    'control.project.purged',
    projectId,
  );
  if (!envelope) {
    throw new Error(`control.project.purged not published for project ${projectId}`);
  }
  if (envelope.type !== 'control.project.purged') {
    throw new Error(`expected control.project.purged, got ${String(envelope.type)}`);
  }
  if (envelope.projectId !== projectId) {
    throw new Error(
      `envelope projectId mismatch: expected ${projectId}, got ${String(envelope.projectId)}`,
    );
  }
}

/** Wait until a Mongo collection has at least `min` rows for the project. */
export async function waitForMongoEntityCount(
  mongo: BoxMongoReader,
  collection: string,
  projectId: string,
  min = 1,
  timeoutMs = 45_000,
): Promise<void> {
  await waitFor(
    async () => ((await mongo.countByProject(collection, projectId)) >= min ? true : false),
    { label: `${collection} count >= ${min} for ${projectId}`, timeoutMs },
  );
}

/** Default wait for async peer purge after `control.project.purged` (the box stand under load). */
export const PROJECT_PURGE_MONGO_TIMEOUT_MS = 300_000;

/** Wait until a Mongo collection has no rows left for the project (async peer purge). */
export async function waitForProjectCollectionPurged(
  mongo: BoxMongoReader,
  collection: string,
  projectId: string,
  timeoutMs = PROJECT_PURGE_MONGO_TIMEOUT_MS,
): Promise<void> {
  await waitFor(
    async () => ((await mongo.countByProject(collection, projectId)) === 0 ? true : false),
    { label: `${collection} purged for ${projectId}`, timeoutMs },
  );
}

export function actorMetadata(projectId: string, userId: string): Metadata {
  const md = serviceMetadata(projectId);
  md.set('x-user-id', userId);
  return md;
}

export async function teardownOffboardProject(
  harness: LocalControlHarness,
  projectId: string,
  actorUserId?: string,
): Promise<void> {
  await archiveBoxTestProjectViaControl(harness, projectId, actorUserId);
}

/** One-shot harness for a single purge integration spec (avoids cross-test outbox contention). */
export interface IsolatedPurgeHarness {
  harness: LocalControlHarness;
  gateway: BoxGatewayRestClient;
  mongo: BoxMongoReader;
  postgres: BoxPostgresHelper;
  actorUserId: string;
  stop: () => Promise<void>;
}

export async function setupIsolatedPurgeHarness(): Promise<IsolatedPurgeHarness> {
  const harness = await startLocalControlApp();
  const actorUserId = await resolveBoxActorUserId();
  const gateway = await createBoxGatewayClient();
  const mongo = await BoxMongoReader.connect();
  const postgres = await BoxPostgresHelper.connect();
  return {
    harness,
    gateway,
    mongo,
    postgres,
    actorUserId,
    stop: async () => {
      await harness.stop();
      await mongo.close();
      await postgres.close();
    },
  };
}

/** Run a spec callback with a fresh harness; no-op cost when the test is skipped. */
export async function withIsolatedPurgeHarness(
  fn: (ctx: IsolatedPurgeHarness) => Promise<void>,
): Promise<void> {
  const ctx = await setupIsolatedPurgeHarness();
  try {
    await fn(ctx);
  } finally {
    await ctx.stop();
  }
}

/** Poll documents gRPC until a published template exists for the given context. */
export async function waitForPublishedTemplate(
  projectId: string,
  contextType: string,
  timeoutMs = 90_000,
): Promise<string> {
  const documents = createDocumentsGrpcClient(BOX_CONN.grpc.documents);
  const md = serviceMetadata(projectId);
  return waitFor(
    async () => {
      const r = await documents.listTemplates({ project_id: projectId }, md);
      const list = (r.list ?? r.templates ?? []) as Array<{
        id?: string;
        context_type?: string;
        contextType?: string;
        status?: string;
      }>;
      const tpl = list.find(
        (t) =>
          (t.context_type ?? t.contextType) === contextType &&
          String(t.status ?? 'published') === 'published',
      );
      const id = String(tpl?.id ?? '');
      return id || false;
    },
    { label: `published ${contextType} template`, timeoutMs },
  );
}
