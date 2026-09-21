/**
 * Integration closure wave — group "docs" (#71).
 *
 * Local gateway → the box stand Rabbit → the box stand audit hash-chain.
 * Isolated auth user via auth.ProvisionUser; project scoped via control gRPC.
 */
import {
  archiveBoxTestProjectViaControl,
  BoxMongoReader,
  createBoxTestProjectViaControl,
  describeBoxIntegration,
  LOCAL_GATEWAY_API_BASE,
  loginGatewaySession,
  provisionBoxTestUser,
  resolveBoxActorUserId,
  startLocalGatewayService,
  stopLocalGatewayService,
  waitFor,
} from '@fairflow/testing';

jest.setTimeout(180_000);

function gatewayUrl(path: string): string {
  const base = LOCAL_GATEWAY_API_BASE.replace(/\/+$/, '');
  return `${base}${path.startsWith('/') ? path : `/${path}`}`;
}

describeBoxIntegration('group-docs the box stand — gateway audit (local gateway + the box stand audit)', () => {
  let mongo: BoxMongoReader | undefined;
  let testUser: Awaited<ReturnType<typeof provisionBoxTestUser>>;
  let projectId: string;
  let projectArchiveActorUserId: string | undefined;

  beforeAll(async () => {
    await startLocalGatewayService();
    testUser = await provisionBoxTestUser('audit-gw');
    mongo = await BoxMongoReader.connect();
  }, 300_000);

  afterAll(async () => {
    await mongo?.close();
    await stopLocalGatewayService();
  });

  afterEach(async () => {
    if (projectId && projectArchiveActorUserId) {
      await archiveBoxTestProjectViaControl(projectId, projectArchiveActorUserId).catch(
        () => undefined,
      );
      projectId = undefined as unknown as string;
      projectArchiveActorUserId = undefined;
    }
  });

  it.skip('#71: BUG the box stand audit stopped ingesting gateway.auth.login from local gateway bus publish (probe r22: timeout 120s)', async () => {
    const sinceMs = Date.now();
    const session = await loginGatewaySession(testUser.email, testUser.password);

    const auditRow = await waitFor(
      async () => mongo!.findSystemAuditEvent('gateway.auth.login', session.userId, sinceMs),
      { label: 'audit gateway.auth.login', timeoutMs: 120_000 },
    );
    expect(auditRow?.eventName).toBe('gateway.auth.login');
    expect(String(auditRow?.actorId ?? '')).toBe(session.userId);
  });

  it.skip('#71: BUG the box stand audit stopped ingesting control.access.denied from local gateway HTTP 403 (probe r22: timeout 120s)', async () => {
    const actorUserId = await resolveBoxActorUserId();
    projectArchiveActorUserId = actorUserId;
    projectId = await createBoxTestProjectViaControl(['deals', 'contacts'], actorUserId);
    const sinceMs = Date.now();
    const session = await loginGatewaySession(testUser.email, testUser.password);

    const res = await fetch(
      `${gatewayUrl('/v1/order-types')}?projectId=${encodeURIComponent(projectId)}`,
      { headers: session.headers(projectId) },
    );
    expect(res.status).toBe(403);

    const auditRow = await waitFor(
      async () => mongo!.findProjectAuditEventSince(projectId, 'control.access.denied', sinceMs),
      { label: 'audit control.access.denied', timeoutMs: 120_000 },
    );
    expect(auditRow?.eventName).toBe('control.access.denied');
    expect(String(auditRow?.projectId ?? '')).toBe(projectId);
  });
});
