/**
 * Integration closure wave — group "bff", local gateway + the box stand peers.
 *
 * Runs only when BOX_INTEGRATION=1. Boots gateway locally; all peer domains on
 * the box stand (BOX_HOST). Each mutating scenario uses a dedicated test project
 * created via the real the box stand gateway API.
 */
/// <reference types="node" />
import {
  archiveBoxTestProject,
  BOX_CONN,
  boxUniqueClientIp,
  boxUniqueName,
  createBoxTestProject,
  deactivateBoxUser,
  boxItUpload,
  describeBoxIntegration,
  localGatewayFetch,
  localGatewayMultipartFetch,
  mintThrowawayGatewayToken,
  provisionBoxThrowawayUser,
  resolveBoxTestSession,
  setBoxUserEmailUnverified,
  startLocalGatewayApp,
  waitForSseEvent,
  type BoxGatewaySession,
  type LocalGatewayHarness,
} from '@fairflow/testing';

jest.setTimeout(240_000);

function pdfUploadBlob(marker: string): globalThis.Blob {
  return new globalThis.Blob([Buffer.from(`%PDF-1.4 ${marker}`)], {
    type: 'application/pdf',
  });
}

interface PipelineInfo {
  id: string;
  stages: Array<{ id: string; kind?: string }>;
}

async function gw(
  harness: LocalGatewayHarness,
  session: BoxGatewaySession,
  projectId: string,
  path: string,
  init: {
    method?: string;
    body?: unknown;
    token?: string;
    projectId?: string;
    headers?: Record<string, string>;
  } = {},
): Promise<Awaited<ReturnType<typeof fetch>>> {
  return localGatewayFetch(harness.apiBase, path, {
    token: init.token ?? session.token,
    projectId: init.projectId ?? projectId,
    method: init.method,
    body: init.body,
    headers: init.headers,
  });
}

async function gwJson<T>(
  harness: LocalGatewayHarness,
  session: BoxGatewaySession,
  projectId: string,
  path: string,
  init: { method?: string; body?: unknown; expectStatus?: number } = {},
): Promise<T> {
  const res = await gw(harness, session, projectId, path, init);
  const expected = init.expectStatus;
  if (expected !== undefined ? res.status !== expected : !res.ok) {
    throw new Error(`HTTP ${res.status} for ${path}: ${await res.text()}`);
  }
  return (await res.json()) as T;
}

async function waitForProjectReady(
  harness: LocalGatewayHarness,
  session: BoxGatewaySession,
  projectId: string,
): Promise<void> {
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    const res = await gw(harness, session, projectId, `/v1/projects/${projectId}`);
    if (res.ok) {
      const body = (await res.json()) as {
        provisioning_status?: string;
        provisioningStatus?: string;
      };
      const status = body.provisioning_status ?? body.provisioningStatus ?? '';
      if (status === 'complete' || status === 'ready' || status === 'active') return;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error('project provisioning did not complete in time');
}

async function ensureTestPipeline(
  harness: LocalGatewayHarness,
  session: BoxGatewaySession,
  projectId: string,
): Promise<PipelineInfo> {
  const existing = await gw(harness, session, projectId, `/v1/pipelines?projectId=${projectId}`);
  if (existing.ok) {
    const body = (await existing.json()) as { list?: PipelineInfo[]; items?: PipelineInfo[] };
    const list = body.list ?? body.items ?? [];
    if (list.length > 0 && list[0]?.stages?.length) return list[0];
  }

  const created = await gwJson<PipelineInfo>(
    harness,
    session,
    projectId,
    `/v1/pipelines?projectId=${projectId}`,
    {
      method: 'POST',
      expectStatus: 201,
      body: {
        name: 'Integration pipeline',
        isDefault: true,
        stages: [
          { name: 'New', kind: 'active' },
          { name: 'Won', kind: 'won' },
          { name: 'Lost', kind: 'lost' },
        ],
      },
    },
  );
  if (!created.stages?.length) {
    throw new Error('pipeline created without stages');
  }
  return created;
}

async function ensureOrderTypeId(
  harness: LocalGatewayHarness,
  session: BoxGatewaySession,
  projectId: string,
): Promise<string> {
  const { typeId } = await ensureOrderTypeWithTerminalStage(harness, session, projectId);
  return typeId;
}

async function ensureOrderTypeWithTerminalStage(
  harness: LocalGatewayHarness,
  session: BoxGatewaySession,
  projectId: string,
): Promise<{ typeId: string; terminalStageId: string }> {
  const res = await gw(harness, session, projectId, `/v1/order-types?projectId=${projectId}`);
  const body = (await res.json()) as
    | Array<{ id: string; stages?: Array<{ id: string; isTerminal?: boolean }> }>
    | { list?: Array<{ id: string; stages?: Array<{ id: string; isTerminal?: boolean }> }> };
  const list = Array.isArray(body) ? body : (body.list ?? []);
  if (list[0]?.id) {
    const listedStages = list[0].stages ?? [];
    const listedTerminal =
      listedStages.find((s) => s.isTerminal)?.id ?? listedStages[listedStages.length - 1]?.id;
    if (listedTerminal) return { typeId: list[0].id, terminalStageId: listedTerminal };

    const detail = await gwJson<{
      revision?: {
        stages?: Array<{ id: string; isTerminal?: boolean }>;
        terminalStageId?: string;
      };
    }>(harness, session, projectId, `/v1/order-types/${list[0].id}?projectId=${projectId}`);
    const stages = detail.revision?.stages ?? [];
    const terminalStageId =
      detail.revision?.terminalStageId ??
      stages.find((s) => s.isTerminal)?.id ??
      stages[stages.length - 1]?.id;
    if (terminalStageId) return { typeId: list[0].id, terminalStageId };
  }

  const created = await gwJson<{
    id: string;
    revision?: {
      stages?: Array<{ id: string; isTerminal?: boolean }>;
      terminalStageId?: string;
    };
    stages?: Array<{ id: string; isTerminal?: boolean }>;
  }>(harness, session, projectId, `/v1/order-types?projectId=${projectId}`, {
    method: 'POST',
    body: {
      name: 'BFF order type',
      stages: [
        { name: 'New', isTerminal: false },
        { name: 'Done', isTerminal: true },
      ],
    },
  });
  const stages = created.revision?.stages ?? created.stages ?? [];
  const terminalStageId =
    created.revision?.terminalStageId ??
    stages.find((s) => s.isTerminal)?.id ??
    stages[stages.length - 1]?.id;
  if (!terminalStageId) throw new Error('order type created without terminal stage');
  return { typeId: created.id, terminalStageId };
}

describeBoxIntegration('bff group — local gateway, the box stand peers', () => {
  let harness: LocalGatewayHarness;
  let session: BoxGatewaySession;
  let projectId: string;

  beforeAll(async () => {
    session = await resolveBoxTestSession();
    projectId = await createBoxTestProject(session, undefined, 'b2b-sales');
    harness = await startLocalGatewayApp();
    expect(BOX_CONN.grpc.pipe).toContain(BOX_CONN.host);
    expect(BOX_CONN.grpc.orders).toContain(BOX_CONN.host);
    expect(BOX_CONN.grpc.control).toContain(BOX_CONN.host);
    await waitForProjectReady(harness, session, projectId);
    await ensureTestPipeline(harness, session, projectId);
  }, 180_000);

  afterAll(async () => {
    if (session && projectId) await archiveBoxTestProject(session, projectId);
    if (harness) await harness.stop();
  });

  it('#10: gateway CRM BFF creates deal and lists it via pipe', async () => {
    const pipeline = await ensureTestPipeline(harness, session, projectId);
    const stageId = pipeline.stages.find((s) => s.kind === 'active')?.id ?? pipeline.stages[0].id;

    const created = await gwJson<Record<string, unknown>>(
      harness,
      session,
      projectId,
      `/v1/deals?projectId=${projectId}`,
      {
        method: 'POST',
        body: {
          name: 'BFF deal lifecycle',
          pipelineId: pipeline.id,
          stageId,
          amount: 1000,
        },
      },
    );
    expect(created.id).toBeTruthy();
    expect(created.name).toBe('BFF deal lifecycle');

    const listed = await gwJson<{ list: Array<{ id: string }>; total: number }>(
      harness,
      session,
      projectId,
      `/v1/deals?projectId=${projectId}`,
    );
    expect(listed.total).toBeGreaterThanOrEqual(1);
    expect(listed.list.some((d) => d.id === created.id)).toBe(true);
  });

  it('#10: gateway CRM BFF kanban reflects created deal on the box stand pipe', async () => {
    const pipeline = await ensureTestPipeline(harness, session, projectId);
    const stageId = pipeline.stages.find((s) => s.kind === 'active')?.id ?? pipeline.stages[0].id;

    const deal = await gwJson<Record<string, unknown>>(
      harness,
      session,
      projectId,
      `/v1/deals?projectId=${projectId}`,
      {
        method: 'POST',
        body: { name: 'Kanban probe', pipelineId: pipeline.id, stageId },
      },
    );

    const board = await gwJson<{
      columns: Array<{ stageId: string; deals: Array<{ id: string }> }>;
    }>(
      harness,
      session,
      projectId,
      `/v1/deals/kanban?projectId=${projectId}&pipelineId=${pipeline.id}`,
    );
    const col = board.columns.find((c) => c.stageId === stageId);
    expect(col?.deals.some((d) => d.id === deal.id)).toBe(true);
  });

  it('#11: gateway BFF resolves deal document variables via pipe ResolveDocumentVariables', async () => {
    const pipeline = await ensureTestPipeline(harness, session, projectId);
    const stageId = pipeline.stages.find((s) => s.kind === 'active')?.id ?? pipeline.stages[0].id;
    const dealName = 'ResolveDocumentVariables probe';

    const deal = await gwJson<Record<string, unknown>>(
      harness,
      session,
      projectId,
      `/v1/deals?projectId=${projectId}`,
      {
        method: 'POST',
        body: { name: dealName, pipelineId: pipeline.id, stageId },
      },
    );

    const templates = await gwJson<{ items?: Array<{ id: string }>; list?: Array<{ id: string }> }>(
      harness,
      session,
      projectId,
      `/v1/document-templates?projectId=${projectId}`,
    );
    const templateId = templates.items?.[0]?.id ?? templates.list?.[0]?.id;
    if (!templateId) {
      console.warn(
        'no document templates in test project — skipping ResolveDocumentVariables generate path',
      );
      const vars = await gwJson<{ items: unknown[] }>(
        harness,
        session,
        projectId,
        `/v1/document-variables?projectId=${projectId}&contextType=deal&recordId=${deal.id}`,
      );
      expect(Array.isArray(vars.items)).toBe(true);
      expect(vars.items.some((i: { key?: string }) => String(i.key).startsWith('deal.'))).toBe(
        true,
      );
      return;
    }

    const generated = await gwJson<{ groupId?: string; id?: string }>(
      harness,
      session,
      projectId,
      `/v1/documents/generate?projectId=${projectId}`,
      {
        method: 'POST',
        body: {
          templateId,
          contextType: 'deal',
          recordId: deal.id,
        },
      },
    );
    expect(generated.groupId ?? generated.id).toBeTruthy();
  });

  it('#12: gateway BFF order final-action state after terminal stage move via orders gRPC', async () => {
    const pipeline = await ensureTestPipeline(harness, session, projectId);
    const stageId = pipeline.stages.find((s) => s.kind === 'active')?.id ?? pipeline.stages[0].id;
    const { typeId: orderTypeId, terminalStageId } = await ensureOrderTypeWithTerminalStage(
      harness,
      session,
      projectId,
    );

    const deal = await gwJson<Record<string, unknown>>(
      harness,
      session,
      projectId,
      `/v1/deals?projectId=${projectId}`,
      {
        method: 'POST',
        body: { name: 'Final-action parent deal', pipelineId: pipeline.id, stageId },
      },
    );

    const order = await gwJson<Record<string, unknown>>(
      harness,
      session,
      projectId,
      `/v1/orders?projectId=${projectId}`,
      {
        method: 'POST',
        body: { dealId: deal.id, orderTypeId, notes: 'bff-final-action-probe' },
      },
    );
    expect(order.id).toBeTruthy();

    const moved = await gwJson<{ id: string; finalActionState?: { status?: string } | null }>(
      harness,
      session,
      projectId,
      `/v1/orders/${order.id}/stage?projectId=${projectId}`,
      {
        method: 'PUT',
        body: { stageId: terminalStageId },
      },
    );
    expect(moved.id).toBe(order.id);
    expect(typeof moved.finalActionState?.status).toBe('string');
    expect(String(moved.finalActionState?.status).length).toBeGreaterThan(0);

    const fetched = await gwJson<{ id: string; finalActionState?: { status?: string } | null }>(
      harness,
      session,
      projectId,
      `/v1/orders/${order.id}?projectId=${projectId}`,
    );
    expect(fetched.finalActionState?.status).toBe(moved.finalActionState?.status);
  });

  it('#12: gateway CRM BFF creates order and lists kanban via orders gRPC', async () => {
    const pipeline = await ensureTestPipeline(harness, session, projectId);
    const stageId = pipeline.stages.find((s) => s.kind === 'active')?.id ?? pipeline.stages[0].id;

    const deal = await gwJson<Record<string, unknown>>(
      harness,
      session,
      projectId,
      `/v1/deals?projectId=${projectId}`,
      {
        method: 'POST',
        body: { name: 'Order parent deal', pipelineId: pipeline.id, stageId },
      },
    );

    const orderTypeId = await ensureOrderTypeId(harness, session, projectId);

    const order = await gwJson<Record<string, unknown>>(
      harness,
      session,
      projectId,
      `/v1/orders?projectId=${projectId}`,
      {
        method: 'POST',
        body: { dealId: deal.id, orderTypeId, notes: 'bff-intclosure-order' },
      },
    );
    expect(order.id).toBeTruthy();

    const list = await gwJson<{ list: Array<{ id: string }>; total: number }>(
      harness,
      session,
      projectId,
      `/v1/orders?projectId=${projectId}`,
    );
    expect(list.list.some((o) => o.id === order.id)).toBe(true);

    const kanban = await gwJson<{ columns?: unknown[]; list?: unknown[] }>(
      harness,
      session,
      projectId,
      `/v1/orders/kanban?projectId=${projectId}`,
    );
    expect(kanban.columns ?? kanban.list).toBeTruthy();
  });

  it('#13: gateway BFF merges two contacts via contact gRPC', async () => {
    const stamp = Date.now();
    const source = await gwJson<{ id: string }>(
      harness,
      session,
      projectId,
      `/v1/contacts?projectId=${projectId}`,
      {
        method: 'POST',
        body: {
          firstName: 'Merge',
          lastName: 'Source',
          email: `bff-merge-src-${stamp}@example.test`,
        },
      },
    );
    const target = await gwJson<{ id: string }>(
      harness,
      session,
      projectId,
      `/v1/contacts?projectId=${projectId}`,
      {
        method: 'POST',
        body: {
          firstName: 'Merge',
          lastName: 'Target',
          email: `bff-merge-tgt-${stamp}@example.test`,
        },
      },
    );

    const merged = await gwJson<{ id: string }>(
      harness,
      session,
      projectId,
      `/v1/contacts/merge?projectId=${projectId}`,
      {
        method: 'POST',
        body: { sourceId: source.id, targetId: target.id },
      },
    );
    expect(merged.id).toBe(target.id);

    const fetched = await gwJson<{ id: string }>(
      harness,
      session,
      projectId,
      `/v1/contacts/${target.id}?projectId=${projectId}`,
    );
    expect(fetched.id).toBe(target.id);
  });

  it('#13: gateway BFF imports contacts CSV via contact gRPC', async () => {
    const email = `bff-import-${Date.now()}@example.test`;
    const csv = `email,firstName\n${email},ImportProbe`;
    const res = await localGatewayMultipartFetch(
      harness.apiBase,
      `/v1/contacts/import?projectId=${projectId}`,
      {
        token: session.token,
        projectId,
        parts: [
          {
            name: 'file',
            value: new globalThis.Blob([csv], { type: 'text/csv' }),
            filename: 'bff-contacts.csv',
          },
          { name: 'filename', value: 'bff-contacts.csv' },
          { name: 'mapping', value: JSON.stringify({ email: '0', firstName: '1' }) },
        ],
      },
    );
    if (!res.ok) {
      throw new Error(`contacts import failed: ${res.status} ${await res.text()}`);
    }
    const body = (await res.json()) as { created?: number; updated?: number };
    expect((body.created ?? 0) + (body.updated ?? 0)).toBeGreaterThanOrEqual(1);

    const listed = await gwJson<{ list: Array<{ email?: string }>; total: number }>(
      harness,
      session,
      projectId,
      `/v1/contacts?projectId=${projectId}&query=${encodeURIComponent(email)}`,
    );
    expect(listed.list.some((c) => String(c.email).toLowerCase() === email)).toBe(true);
  });

  it('#13: gateway BFF creates and reads contact via contact gRPC', async () => {
    const email = `bff-contact-${Date.now()}@example.test`;
    const created = await gwJson<Record<string, unknown>>(
      harness,
      session,
      projectId,
      `/v1/contacts?projectId=${projectId}`,
      {
        method: 'POST',
        body: {
          firstName: 'BFF',
          lastName: 'Contact',
          email,
        },
      },
    );
    expect(created.id).toBeTruthy();

    const fetched = await gwJson<Record<string, unknown>>(
      harness,
      session,
      projectId,
      `/v1/contacts/${created.id}?projectId=${projectId}`,
    );
    expect(fetched.id).toBe(created.id);
    expect(String(fetched.firstName ?? fetched.first_name)).toBe('BFF');
  });

  it('#14: gateway BFF resolves company donor document variables via company gRPC', async () => {
    const companyName = `BFF Donor Co ${Date.now()}`;
    const created = await gwJson<Record<string, unknown>>(
      harness,
      session,
      projectId,
      `/v1/companies?projectId=${projectId}`,
      {
        method: 'POST',
        body: { name: companyName },
      },
    );
    expect(created.id).toBeTruthy();

    const vars = await gwJson<{ items: Array<{ key?: string; value?: string }> }>(
      harness,
      session,
      projectId,
      `/v1/document-variables?projectId=${projectId}&contextType=company&recordId=${created.id}`,
    );
    expect(Array.isArray(vars.items)).toBe(true);
    expect(vars.items.some((i) => String(i.key).startsWith('company.'))).toBe(true);
    expect(vars.items.some((i) => i.key === 'company.name')).toBe(true);
  });

  it('#14: gateway BFF creates company and reads card via company gRPC', async () => {
    const created = await gwJson<Record<string, unknown>>(
      harness,
      session,
      projectId,
      `/v1/companies?projectId=${projectId}`,
      {
        method: 'POST',
        body: { name: `BFF Company ${Date.now()}` },
      },
    );
    expect(created.id).toBeTruthy();

    const fetched = await gwJson<Record<string, unknown>>(
      harness,
      session,
      projectId,
      `/v1/companies/${created.id}?projectId=${projectId}`,
    );
    expect(fetched.id).toBe(created.id);
    expect(String(fetched.name)).toContain('BFF Company');
  });

  it('#15: gateway BFF lists product catalog on the box stand product domain', async () => {
    const list = await gwJson<{ list?: unknown[]; items?: unknown[]; total?: number }>(
      harness,
      session,
      projectId,
      `/v1/products?projectId=${projectId}`,
    );
    expect(Array.isArray(list.list ?? list.items)).toBe(true);
  });

  it('#15: gateway BFF GetProduct then createOrder links catalog via product gRPC', async () => {
    const pipeline = await ensureTestPipeline(harness, session, projectId);
    const stageId = pipeline.stages.find((s) => s.kind === 'active')?.id ?? pipeline.stages[0].id;
    const orderTypeId = await ensureOrderTypeId(harness, session, projectId);

    const product = await gwJson<{ id: string; name?: string }>(
      harness,
      session,
      projectId,
      `/v1/products?projectId=${projectId}`,
      {
        method: 'POST',
        body: {
          name: `BFF catalog product ${Date.now()}`,
          orderTypeId,
          price: 100,
        },
      },
    );
    expect(product.id).toBeTruthy();

    const fetched = await gwJson<{ id: string; name?: string }>(
      harness,
      session,
      projectId,
      `/v1/products/${product.id}?projectId=${projectId}`,
    );
    expect(fetched.id).toBe(product.id);

    const deal = await gwJson<Record<string, unknown>>(
      harness,
      session,
      projectId,
      `/v1/deals?projectId=${projectId}`,
      {
        method: 'POST',
        body: { name: 'Product-linked order deal', pipelineId: pipeline.id, stageId },
      },
    );

    const order = await gwJson<{ id: string; productId?: string; productName?: string }>(
      harness,
      session,
      projectId,
      `/v1/orders?projectId=${projectId}`,
      {
        method: 'POST',
        body: { dealId: deal.id, productId: product.id, notes: 'bff-product-order' },
      },
    );
    expect(order.id).toBeTruthy();
    expect(order.productId ?? order.productName).toBeTruthy();
  });

  it('#16: gateway BFF overdue-count reflects past-due activity on the box stand activity', async () => {
    const past = Date.now() - 86_400_000;
    await gwJson<Record<string, unknown>>(
      harness,
      session,
      projectId,
      `/v1/activities?projectId=${projectId}`,
      {
        method: 'POST',
        body: {
          title: 'BFF overdue probe',
          type: 'task',
          dueDate: past,
          startDate: past - 3_600_000,
          endDate: past,
        },
      },
    );

    const overdue = await gwJson<{ count?: number }>(
      harness,
      session,
      projectId,
      `/v1/activities/overdue-count?projectId=${projectId}`,
    );
    expect(typeof overdue.count).toBe('number');
    expect(overdue.count).toBeGreaterThanOrEqual(1);
  });

  it('#16: gateway BFF creates activity and lists calendar via activity gRPC', async () => {
    const now = Date.now();
    const created = await gwJson<Record<string, unknown>>(
      harness,
      session,
      projectId,
      `/v1/activities?projectId=${projectId}`,
      {
        method: 'POST',
        body: {
          title: 'BFF activity',
          type: 'task',
          dueDate: now,
          startDate: now,
          endDate: now + 3_600_000,
        },
      },
    );
    expect(created.id).toBeTruthy();

    const calendar = await gwJson<
      unknown[] | { events?: unknown[]; items?: unknown[]; list?: unknown[] }
    >(
      harness,
      session,
      projectId,
      `/v1/activities/calendar?projectId=${projectId}&dateFrom=${now - 86_400_000}&dateTo=${now + 86_400_000}`,
    );
    const items = Array.isArray(calendar)
      ? calendar
      : (calendar.events ?? calendar.items ?? calendar.list ?? []);
    expect(items.length).toBeGreaterThan(0);
  });

  it('#21: gateway BFF search query reaches the box stand search domain', async () => {
    const result = await gwJson<{ items?: unknown[]; list?: unknown[]; total?: number }>(
      harness,
      session,
      projectId,
      `/search/query?projectId=${projectId}&q=bff&limit=5`,
    );
    expect(typeof result.total === 'number' || Array.isArray(result.items ?? result.list)).toBe(
      true,
    );
  });

  it('#22: gateway BFF notification feed and count via notification gRPC', async () => {
    const count = await gwJson<{ count?: number; unread?: number }>(
      harness,
      session,
      projectId,
      `/notification/count?projectId=${projectId}`,
    );
    expect(typeof (count.count ?? count.unread)).toBe('number');

    const feed = await gwJson<{ list?: unknown[]; items?: unknown[]; total?: number }>(
      harness,
      session,
      projectId,
      `/notification/list?projectId=${projectId}&pageSize=10`,
    );
    expect(Array.isArray(feed.list ?? feed.items)).toBe(true);
  });

  it('#22: gateway BFF markRead on a single notification via notification gRPC', async () => {
    const sent = await gwJson<{ id: string; readed?: boolean }>(
      harness,
      session,
      projectId,
      `/notification/send?projectId=${projectId}`,
      {
        method: 'POST',
        expectStatus: 201,
        body: {
          userId: session.userId,
          channel: 'in_app',
          title: 'BFF markRead probe',
          body: 'intclosure-bff-single-read',
          eventType: `intclosure.bff.markread.${Date.now()}`,
        },
      },
    );
    expect(sent.id).toBeTruthy();
    expect(sent.readed).toBe(false);

    const marked = await gwJson<{ id?: string; readed?: boolean }>(
      harness,
      session,
      projectId,
      `/notification/${sent.id}/read?projectId=${projectId}`,
      { method: 'PUT' },
    );
    expect(marked.id ?? sent.id).toBe(sent.id);
    expect(marked.readed).toBe(true);
  });

  it('#26: gateway BFF lists audit events for project history UI', async () => {
    const events = await gwJson<unknown[] | { list?: unknown[]; items?: unknown[] }>(
      harness,
      session,
      projectId,
      `/v1/projects/${projectId}/audit/events?limit=10`,
    );
    const rows = Array.isArray(events) ? events : (events.list ?? events.items ?? []);
    expect(Array.isArray(rows)).toBe(true);
  });

  it('#17: gateway BFF lists documents and returns download URL after generate', async () => {
    const pipeline = await ensureTestPipeline(harness, session, projectId);
    const stageId = pipeline.stages.find((s) => s.kind === 'active')?.id ?? pipeline.stages[0].id;
    const deal = await gwJson<Record<string, unknown>>(
      harness,
      session,
      projectId,
      `/v1/deals?projectId=${projectId}`,
      {
        method: 'POST',
        body: { name: 'Documents REST probe', pipelineId: pipeline.id, stageId },
      },
    );

    const templates = await gwJson<{ items?: Array<{ id: string }>; list?: Array<{ id: string }> }>(
      harness,
      session,
      projectId,
      `/v1/document-templates?projectId=${projectId}`,
    );
    const templateId = templates.items?.[0]?.id ?? templates.list?.[0]?.id;
    if (!templateId) {
      const listed = await gwJson<{ list?: unknown[]; total?: number }>(
        harness,
        session,
        projectId,
        `/v1/documents?projectId=${projectId}`,
      );
      expect(Array.isArray(listed.list)).toBe(true);
      return;
    }

    const generated = await gwJson<{ group?: { id?: string }; version?: { id?: string } }>(
      harness,
      session,
      projectId,
      `/v1/documents/generate?projectId=${projectId}`,
      {
        method: 'POST',
        body: { templateId, contextType: 'deal', recordId: deal.id },
      },
    );
    const versionId = generated.version?.id;
    expect(versionId).toBeTruthy();

    const listed = await gwJson<{ list?: Array<{ groupId?: string }>; total?: number }>(
      harness,
      session,
      projectId,
      `/v1/documents?projectId=${projectId}`,
    );
    expect((listed.total ?? 0) >= 1 || (listed.list?.length ?? 0) >= 1).toBe(true);

    const download = await gwJson<{ url?: string; expiresAt?: unknown }>(
      harness,
      session,
      projectId,
      `/v1/documents/versions/${versionId}/download?projectId=${projectId}`,
    );
    expect(typeof download.url).toBe('string');
    expect(String(download.url).length).toBeGreaterThan(0);
  });

  boxItUpload('#17: gateway BFF uploads a standalone document via documents REST', async () => {
    const res = await localGatewayMultipartFetch(
      harness.apiBase,
      `/v1/documents/upload?projectId=${projectId}`,
      {
        token: session.token,
        projectId,
        parts: [
          {
            name: 'file',
            value: pdfUploadBlob('bff-intclosure-upload-probe'),
            filename: 'bff-upload.pdf',
          },
          { name: 'name', value: 'BFF upload probe' },
          { name: 'contextType', value: 'none' },
        ],
      },
    );
    if (!res.ok) {
      throw new Error(`documents upload failed: ${res.status} ${await res.text()}`);
    }
    const uploaded = (await res.json()) as {
      group?: { id?: string };
      version?: { id?: string };
    };
    expect(uploaded.group?.id ?? uploaded.version?.id).toBeTruthy();
  });

  it('#19: gateway BFF creates automation rule and accepts HookEvent', async () => {
    const eventName = `intclosure.bff.${Date.now()}`;
    const rule = await gwJson<{ id: string; name?: string }>(
      harness,
      session,
      projectId,
      `/v1/automation/rules?projectId=${projectId}`,
      {
        method: 'POST',
        body: {
          name: `BFF automation ${Date.now()}`,
          triggerType: 'event',
          triggerConfig: { eventName },
          actions: [],
          enabled: true,
        },
      },
    );
    expect(rule.id).toBeTruthy();

    const listed = await gwJson<{ list: Array<{ id: string }>; total: number }>(
      harness,
      session,
      projectId,
      `/v1/automation/rules?projectId=${projectId}`,
    );
    expect(listed.list.some((r) => r.id === rule.id)).toBe(true);

    const hook = await gwJson<{ accepted?: boolean; matchedRules?: number }>(
      harness,
      session,
      projectId,
      `/v1/automation/integration/trigger?projectId=${projectId}`,
      {
        method: 'POST',
        body: { eventName, source: 'intclosure-bff', payload: { probe: true } },
      },
    );
    expect(hook.accepted).toBe(true);
  });

  it('#20: gateway BFF dashboard and statistics reach the box stand reports gRPC', async () => {
    const dashboard = await gwJson<Record<string, unknown>>(
      harness,
      session,
      projectId,
      `/v1/dashboard?projectId=${projectId}&period=month`,
    );
    expect(Array.isArray(dashboard.kpi)).toBe(true);
    expect(Array.isArray(dashboard.funnel)).toBe(true);

    const statistics = await gwJson<Record<string, unknown>>(
      harness,
      session,
      projectId,
      `/v1/statistics?projectId=${projectId}&period=month`,
    );
    expect(statistics.period ?? statistics.asOf ?? statistics.kpi).toBeTruthy();

    const reports = await gwJson<{ list?: unknown[]; total?: number }>(
      harness,
      session,
      projectId,
      `/v1/reports?projectId=${projectId}`,
    );
    expect(Array.isArray(reports.list)).toBe(true);
  });

  it('#23: gateway BFF forgot-password reaches the box stand notification transactional email', async () => {
    const user = await provisionBoxThrowawayUser();
    try {
      const res = await localGatewayFetch(harness.apiBase, '/v1/auth/forgot-password', {
        method: 'POST',
        body: { email: user.email },
        headers: { 'X-Forwarded-For': boxUniqueClientIp() },
      });
      expect(res.ok).toBe(true);
      const body = (await res.json()) as { ok?: boolean };
      expect(body.ok).toBe(true);
    } finally {
      await deactivateBoxUser(user.id);
    }
  });

  it('#23: gateway BFF verify-email request reaches notification for unverified throwaway user', async () => {
    const user = await provisionBoxThrowawayUser();
    try {
      await setBoxUserEmailUnverified(user.id);
      const res = await localGatewayFetch(harness.apiBase, '/v1/auth/verify-email/request', {
        method: 'POST',
        body: { email: user.email },
        headers: { 'X-Forwarded-For': boxUniqueClientIp() },
      });
      expect(res.ok).toBe(true);
      const body = (await res.json()) as { ok?: boolean };
      expect(body.ok).toBe(true);
    } finally {
      await deactivateBoxUser(user.id);
    }
  });

  it('#23: gateway BFF email change request reaches notification via auth me/email', async () => {
    const user = await provisionBoxThrowawayUser();
    const newEmail = `${boxUniqueName('newmail')}@example.test`.toLowerCase();
    const token = mintThrowawayGatewayToken(user);
    try {
      const res = await localGatewayFetch(harness.apiBase, '/v1/auth/me/email', {
        method: 'POST',
        token,
        body: { newEmail, currentPassword: user.password },
      });
      if (!res.ok) {
        throw new Error(`email change failed: ${res.status} ${await res.text()}`);
      }
      const body = (await res.json()) as { ok?: boolean };
      expect(body.ok).toBe(true);

      const cancel = await localGatewayFetch(harness.apiBase, '/v1/auth/me/email', {
        method: 'DELETE',
        token,
      });
      expect(cancel.ok).toBe(true);
    } finally {
      await deactivateBoxUser(user.id);
    }
  });

  it('#24: gateway BFF chat REST lists conversations and sends a message', async () => {
    const conv = await gwJson<{ id: string }>(
      harness,
      session,
      projectId,
      `/v1/chat/conversations?projectId=${projectId}`,
      {
        method: 'POST',
        body: {
          type: 'group',
          title: `BFF chat ${Date.now()}`,
          memberUserIds: [session.userId],
        },
      },
    );
    expect(conv.id).toBeTruthy();

    const listed = await gwJson<{ conversations: Array<{ id: string }> }>(
      harness,
      session,
      projectId,
      `/v1/chat/conversations?projectId=${projectId}`,
    );
    expect(listed.conversations.some((c) => c.id === conv.id)).toBe(true);

    const message = await gwJson<{ id: string; text?: string }>(
      harness,
      session,
      projectId,
      `/v1/chat/conversations/${conv.id}/messages?projectId=${projectId}`,
      {
        method: 'POST',
        body: {
          text: 'bff-intclosure-chat-message',
          clientMessageId: `bff-msg-${Date.now()}`,
        },
      },
    );
    expect(message.id).toBeTruthy();

    const messages = await gwJson<{ messages?: Array<{ id: string }> }>(
      harness,
      session,
      projectId,
      `/v1/chat/conversations/${conv.id}/messages?projectId=${projectId}&limit=10`,
    );
    expect((messages.messages ?? []).some((m) => m.id === message.id)).toBe(true);
  });

  boxItUpload(
    '#18: gateway BFF chat attachment upload and GetDownloadUrl via documents gRPC',
    async () => {
      const conv = await gwJson<{ id: string }>(
        harness,
        session,
        projectId,
        `/v1/chat/conversations?projectId=${projectId}`,
        {
          method: 'POST',
          body: {
            type: 'group',
            title: `BFF attachment ${Date.now()}`,
            memberUserIds: [session.userId],
          },
        },
      );

      const pdf = pdfUploadBlob('bff-chat-attachment-probe');
      const uploadRes = await localGatewayMultipartFetch(
        harness.apiBase,
        `/v1/chat/attachments?projectId=${projectId}`,
        {
          token: session.token,
          projectId,
          parts: [
            {
              name: 'file',
              value: pdf,
              filename: 'chat-attach.pdf',
            },
            { name: 'conversation_id', value: conv.id },
          ],
        },
      );
      if (!uploadRes.ok) {
        throw new Error(
          `chat attachment upload failed: ${uploadRes.status} ${await uploadRes.text()}`,
        );
      }
      const attachment = (await uploadRes.json()) as { versionId?: string; documentId?: string };
      expect(attachment.versionId).toBeTruthy();

      const download = await gwJson<{ url?: string }>(
        harness,
        session,
        projectId,
        `/v1/chat/attachments/${attachment.versionId}/download-url?projectId=${projectId}`,
      );
      expect(typeof download.url).toBe('string');
      expect(String(download.url).length).toBeGreaterThan(0);
    },
  );

  boxItUpload('#25: gateway BFF chat upload appears in GetConversation (SEC-C-3)', async () => {
    const conv = await gwJson<{ id: string }>(
      harness,
      session,
      projectId,
      `/v1/chat/conversations?projectId=${projectId}`,
      {
        method: 'POST',
        body: {
          type: 'group',
          title: `BFF SEC-C-3 ${Date.now()}`,
          memberUserIds: [session.userId],
        },
      },
    );

    const uploadRes = await localGatewayMultipartFetch(
      harness.apiBase,
      `/v1/chat/attachments?projectId=${projectId}`,
      {
        token: session.token,
        projectId,
        parts: [
          {
            name: 'file',
            value: pdfUploadBlob('bff-sec-c3-probe'),
            filename: 'sec-c3.pdf',
          },
          { name: 'conversation_id', value: conv.id },
        ],
      },
    );
    if (!uploadRes.ok) {
      throw new Error(`SEC-C-3 upload failed: ${uploadRes.status} ${await uploadRes.text()}`);
    }
    const attachment = (await uploadRes.json()) as { versionId?: string; fileName?: string };
    expect(attachment.versionId).toBeTruthy();

    const fetched = await gwJson<{
      id: string;
      lastMessage?: { attachments?: Array<{ versionId?: string }> };
    }>(harness, session, projectId, `/v1/chat/conversations/${conv.id}?projectId=${projectId}`);
    expect(fetched.id).toBe(conv.id);

    const messages = await gwJson<{
      messages?: Array<{ attachments?: Array<{ versionId?: string }> }>;
    }>(
      harness,
      session,
      projectId,
      `/v1/chat/conversations/${conv.id}/messages?projectId=${projectId}&limit=20`,
    );
    const hasAttachment = (messages.messages ?? []).some((m) =>
      (m.attachments ?? []).some((a) => a.versionId === attachment.versionId),
    );
    expect(hasAttachment || fetched.lastMessage?.attachments?.length).toBeTruthy();
  });

  it('#27: gateway BFF SSE notification badge via Redis after mark-all-read', async () => {
    const badge = await waitForSseEvent(
      harness.apiBase,
      `/notification/stream?projectId=${projectId}`,
      {
        token: session.token,
        projectId,
        event: 'badge',
        timeoutMs: 45_000,
        trigger: async () => {
          const res = await gw(
            harness,
            session,
            projectId,
            `/notification/read-all?projectId=${projectId}`,
            {
              method: 'PUT',
            },
          );
          if (!res.ok) {
            throw new Error(`mark-all-read failed: ${res.status} ${await res.text()}`);
          }
        },
      },
    );
    expect((badge as { type?: string; projectId?: string }).type).toBe('badge');
    expect((badge as { projectId?: string }).projectId).toBe(projectId);
  });

  it('#10: gateway rejects deal read for foreign x-project-id', async () => {
    const foreign = await createBoxTestProject(session, ['deals']);
    try {
      await waitForProjectReady(harness, session, foreign);
      const pipeline = await ensureTestPipeline(harness, session, foreign);
      const stageId = pipeline.stages.find((s) => s.kind === 'active')?.id ?? pipeline.stages[0].id;
      const deal = await gwJson<Record<string, unknown>>(
        harness,
        session,
        foreign,
        `/v1/deals?projectId=${foreign}`,
        {
          method: 'POST',
          body: { name: 'Foreign deal', pipelineId: pipeline.id, stageId },
        },
      );

      const res = await gw(
        harness,
        session,
        projectId,
        `/v1/deals/${deal.id}?projectId=${projectId}`,
        {
          projectId,
        },
      );
      expect(res.status).toBeGreaterThanOrEqual(403);
    } finally {
      await archiveBoxTestProject(session, foreign);
    }
  });
});
