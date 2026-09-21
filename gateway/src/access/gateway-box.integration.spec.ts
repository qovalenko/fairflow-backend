/**
 * Integration closure wave — group "access", local gateway + the box stand peers.
 *
 * Runs only when BOX_INTEGRATION=1. Boots gateway locally; auth/control/… on
 * the box stand (BOX_HOST). Each mutating scenario uses a dedicated test project.
 */
import {
  archiveBoxTestProjectViaLocalGateway,
  BOX_CONN,
  boxUniqueEmail,
  boxUniqueName,
  boxUniqueClientIp,
  createBoxTestProjectViaLocalGateway,
  describeBoxIntegration,
  localGatewayFetch,
  resolveBoxTestSession,
  startLocalGatewayApp,
  type BoxGatewaySession,
  type LocalGatewayHarness,
} from '@fairflow/testing';

jest.setTimeout(240_000);

async function gwJson<T>(
  harness: LocalGatewayHarness,
  session: BoxGatewaySession,
  path: string,
  init: {
    method?: string;
    body?: unknown;
    token?: string;
    projectId?: string;
    expectStatus?: number;
    headers?: Record<string, string>;
  } = {},
): Promise<T> {
  const res = await localGatewayFetch(harness.apiBase, path, {
    token: init.token ?? session.token,
    projectId: init.projectId,
    method: init.method,
    body: init.body,
    headers: init.headers,
  });
  const expected = init.expectStatus;
  if (expected !== undefined ? res.status !== expected : !res.ok) {
    throw new Error(`HTTP ${res.status} for ${path}: ${await res.text()}`);
  }
  return (await res.json()) as T;
}

describeBoxIntegration('access group — local gateway, the box stand peers', () => {
  let harness: LocalGatewayHarness;
  let session: BoxGatewaySession;
  let projectId: string;
  let guardProjectId: string;

  beforeAll(async () => {
    process.env.BOX_DATA_PREFIX = 'intclosure-access-';
    process.env.YANDEX_OAUTH_CLIENT_ID =
      process.env.YANDEX_OAUTH_CLIENT_ID ?? 'intclosure-probe-client';
    process.env.YANDEX_OAUTH_CLIENT_SECRET =
      process.env.YANDEX_OAUTH_CLIENT_SECRET ?? 'intclosure-probe-secret';
    session = await resolveBoxTestSession();
    harness = await startLocalGatewayApp();
    expect(BOX_CONN.grpc.auth).toContain(BOX_CONN.host);
    expect(BOX_CONN.grpc.control).toContain(BOX_CONN.host);
    projectId = await createBoxTestProjectViaLocalGateway(harness.apiBase, session);
    guardProjectId = await createBoxTestProjectViaLocalGateway(harness.apiBase, session, ['deals']);
  }, 180_000);

  afterAll(async () => {
    if (session && guardProjectId) {
      await archiveBoxTestProjectViaLocalGateway(harness.apiBase, session, guardProjectId);
    }
    if (session && projectId) {
      await archiveBoxTestProjectViaLocalGateway(harness.apiBase, session, projectId);
    }
    if (harness) await harness.stop();
  });

  it('#28: gateway Yandex OAuth start redirects to provider authorize URL', async () => {
    const res = await fetch(
      `${harness.apiBase}/auth/oauth/yandex?redirectUrl=${encodeURIComponent('http://localhost:5173')}`,
      { redirect: 'manual', headers: { Accept: 'text/html' } },
    );
    expect(res.status).toBe(302);
    const location = res.headers.get('location') ?? '';
    expect(location).toContain('oauth.yandex.ru/authorize');
    expect(location).toContain('client_id=');
  });

  it('#29: gateway OIDC providers list reaches the box stand auth OidcGrpc', async () => {
    const body = await gwJson<{ providers: Array<{ id: string; name: string }> }>(
      harness,
      session,
      '/auth/oidc/providers',
    );
    expect(Array.isArray(body.providers)).toBe(true);
  });

  it('#30: gateway profile BFF lists sessions via auth ListSessions', async () => {
    const body = await gwJson<{ sessions: Array<{ id: string; isCurrent?: boolean }> }>(
      harness,
      session,
      '/v1/auth/me/sessions',
    );
    expect(Array.isArray(body.sessions)).toBe(true);
  });

  it('#30: gateway profile BFF rejects password change with wrong current password', async () => {
    const res = await localGatewayFetch(harness.apiBase, '/v1/auth/me/password', {
      method: 'POST',
      token: session.token,
      body: { currentPassword: 'wrong-password-intclosure', newPassword: 'NewPass!234' },
    });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
  });

  it('#31: gateway forgot-password returns generic ok without enumeration', async () => {
    const email = boxUniqueEmail('forgot');
    const body = await gwJson<{ ok: boolean }>(harness, session, '/v1/auth/forgot-password', {
      method: 'POST',
      body: { email },
      headers: { 'X-Forwarded-For': boxUniqueClientIp() },
    });
    expect(body.ok).toBe(true);
  });

  it('#31: gateway reset-password rejects invalid token', async () => {
    const res = await localGatewayFetch(harness.apiBase, '/v1/auth/reset-password', {
      method: 'POST',
      body: { token: 'invalid-intclosure-token', password: 'NewPass!234' },
    });
    expect(res.status).toBeGreaterThanOrEqual(400);
  });

  it('#34: gateway module guard blocks contacts BFF when contacts module is off', async () => {
    const res = await localGatewayFetch(
      harness.apiBase,
      `/v1/contacts?projectId=${guardProjectId}`,
      { token: session.token, projectId: guardProjectId },
    );
    expect(res.status).toBe(403);
    const body = (await res.json()) as { code?: string };
    expect(body.code).toMatch(/MODULE_(POLICY_DENIED|DISABLED)/);
  });

  it('#35: gateway /auth/me hydrates projects via control ListMyProjects', async () => {
    const body = await gwJson<{ user: { projects: Array<{ id: string }> } }>(
      harness,
      session,
      '/v1/auth/me',
    );
    const ids = (body.user.projects ?? []).map((p) => p.id);
    expect(ids).toContain(projectId);
  });

  it('#36: gateway BFF creates project and toggles module via control lifecycle', async () => {
    const created = await gwJson<{ id: string; name: string }>(harness, session, '/v1/projects', {
      method: 'POST',
      body: {
        ownerType: 'PERSONAL',
        ownerId: session.userId,
        name: boxUniqueName('bff-mut'),
        templateId: 'blank',
        modules: ['deals', 'contacts'],
      },
    });
    expect(created.id).toBeTruthy();

    try {
      await gwJson(harness, session, `/v1/projects/${created.id}/modules/contacts/disable`, {
        method: 'POST',
        projectId: created.id,
        body: {},
      });

      const modules = await gwJson<
        Array<{ module_id?: string; moduleId?: string; enabled?: boolean }>
      >(harness, session, `/v1/projects/${created.id}/modules`, { projectId: created.id });
      const contacts = modules.find((m) => (m.module_id ?? m.moduleId) === 'contacts');
      expect(contacts?.enabled).toBe(false);

      await gwJson(harness, session, `/v1/projects/${created.id}/modules/contacts/enable`, {
        method: 'POST',
        projectId: created.id,
        body: {},
      });
    } finally {
      await archiveBoxTestProjectViaLocalGateway(harness.apiBase, session, created.id);
    }
  });
});
