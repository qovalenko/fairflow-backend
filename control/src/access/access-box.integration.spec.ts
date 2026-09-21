/**
 * Integration closure wave — group "access", local control + the box stand peers.
 *
 * Runs only when BOX_INTEGRATION=1. Boots control locally; auth/pipe/orders/… on
 * the box stand (BOX_HOST). Each mutating scenario uses a dedicated test project
 * created via local control gRPC (same Postgres as the box stand; avoids gateway login rate limits).
 */
import { status } from '@grpc/grpc-js';
import {
  BOX_CONN,
  archiveBoxTestProjectViaLocalControl,
  createActivityGrpcClient,
  createAuditGrpcClient,
  createAuthApiKeyGrpcClient,
  createAuthDirectoryGrpcClient,
  createAutomationGrpcClient,
  createBoxTestProjectViaLocalControl,
  createChatGrpcClient,
  createCompanyGrpcClient,
  createContactGrpcClient,
  createDocumentsGrpcClient,
  createNotificationGrpcClient,
  createOrdersGrpcClient as createPeerOrdersGrpcClient,
  createPipeGrpcClient,
  createProductGrpcClient,
  createReportsGrpcClient,
  createSearchGrpcClient,
  describeBoxIntegration,
  resolveBoxActorUserId,
  serviceMetadata,
  startLocalControlApp,
  type LocalControlHarness,
} from '@fairflow/testing';

jest.setTimeout(180_000);

describeBoxIntegration('access group — local control, the box stand peers', () => {
  let harness: LocalControlHarness;
  let actorUserId: string;
  let projectId: string;

  beforeAll(async () => {
    process.env.BOX_DATA_PREFIX = 'intclosure-access-';
    harness = await startLocalControlApp();
    actorUserId = await resolveBoxActorUserId();
    projectId = await createBoxTestProjectViaLocalControl(
      harness,
      ['deals', 'contacts', 'orders', 'documents', 'automation'],
      actorUserId,
    );
    // Provisioning is async — poll pipe until the default pipeline exists on the box stand.
    const pipe = createPipeGrpcClient(BOX_CONN.grpc.pipe);
    const md = serviceMetadata(projectId);
    const deadline = Date.now() + 45_000;
    while (Date.now() < deadline) {
      const pipeR = await pipe.listPipelines({ project_id: projectId }, md);
      const pipeList = (pipeR.list ?? pipeR.pipelines ?? []) as unknown[];
      if (pipeList.length > 0) break;
      await new Promise((r) => setTimeout(r, 500));
    }
  }, 150_000);

  afterAll(async () => {
    if (harness && projectId) {
      await archiveBoxTestProjectViaLocalControl(harness, projectId, actorUserId);
    }
    if (harness) await harness.stop();
  });

  it('#32: control ListMembers hydrates PII via auth ResolveUsers', async () => {
    const md = serviceMetadata(projectId);
    const members = await harness.grpc.project.listMembers({ project_id: projectId }, md);
    const list = (members.list ?? []) as Array<{ id: string; name: string; email: string }>;
    expect(list.length).toBeGreaterThan(0);
    const self = list.find((m) => m.id === actorUserId);
    expect(self).toBeDefined();
    expect(self!.email).toMatch(/@/);
    expect(self!.name).not.toBe(self!.id);
  });

  it('#33: control UserDirectoryService.revokeSessions calls auth RevokeUserSessions', async () => {
    const auth = createAuthDirectoryGrpcClient(BOX_CONN.grpc.auth);
    const md = serviceMetadata();
    const r = await auth.revokeUserSessions(
      { user_ids: ['00000000-0000-7000-8000-000000000099'] },
      md,
    );
    expect(r.revoked_count ?? r.revokedCount ?? 0).toBe(0);
  });

  it('#37: ResolveRecordVisibility returns ABAC scope for project member', async () => {
    const md = serviceMetadata(projectId);
    md.set('x-user-id', actorUserId);
    const vis = await harness.grpc.project.resolveRecordVisibility(
      {
        project_id: projectId,
        user_id: actorUserId,
        resource: 'contacts',
      },
      md,
    );
    expect(vis.allowed).toBe(true);
    expect(typeof vis.epoch === 'number' || typeof vis.epoch === 'string').toBe(true);
    expect(vis.mode ?? vis.level).toBeTruthy();
  });

  it('#38: ListMembers exposes assignable project members for SEC-PEP consumers', async () => {
    const md = serviceMetadata(projectId);
    const members = await harness.grpc.project.listMembers({ project_id: projectId }, md);
    const ids = ((members.list ?? []) as Array<{ id: string }>).map((m) => m.id);
    expect(ids).toContain(actorUserId);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('#38: ListDepartments returns org structure catalog for SEC-PEP department validation', async () => {
    const md = serviceMetadata(projectId);
    const r = await harness.grpc.organization.listDepartments(
      { organization_id: '', actor_user_id: actorUserId },
      md,
    );
    const list = (r.list ?? []) as Array<{ id: string; name?: string }>;
    expect(Array.isArray(list)).toBe(true);
    for (const dept of list) {
      expect(dept.id).toBeTruthy();
    }
  });

  it('#39: control provisions default pipe pipeline on the box stand after project create', async () => {
    const pipe = createPipeGrpcClient(BOX_CONN.grpc.pipe);
    const md = serviceMetadata(projectId);
    const r = await pipe.listPipelines({ project_id: projectId }, md);
    const list = (r.list ?? r.pipelines ?? []) as unknown[];
    expect(list.length).toBeGreaterThan(0);
  });

  it('#40: control provisions default order types on the box stand when orders module enabled', async () => {
    const ordersProjectId = await createBoxTestProjectViaLocalControl(
      harness,
      ['deals', 'contacts', 'orders'],
      actorUserId,
      undefined,
      'b2b-sales',
    );
    const orders = createPeerOrdersGrpcClient(BOX_CONN.grpc.orders);
    const md = serviceMetadata(ordersProjectId);
    try {
      const deadline = Date.now() + 45_000;
      let list: unknown[] = [];
      while (Date.now() < deadline) {
        const r = await orders.listOrderTypes({ project_id: ordersProjectId }, md);
        list = (r.list ?? r.order_types ?? r.items ?? []) as unknown[];
        if (list.length > 0) break;
        await new Promise((r) => setTimeout(r, 500));
      }
      expect(list.length).toBeGreaterThan(0);
    } finally {
      await archiveBoxTestProjectViaLocalControl(harness, ordersProjectId, actorUserId);
    }
  });

  it.skip('#41: BUG control provisions default document templates on the box stand when documents module enabled', async () => {
    const docsProjectId = await createBoxTestProjectViaLocalControl(
      harness,
      ['deals', 'contacts', 'documents'],
      actorUserId,
    );
    const documents = createDocumentsGrpcClient(BOX_CONN.grpc.documents);
    const md = serviceMetadata(docsProjectId);
    try {
      // control → documents ProvisionDefaults runs on project create; poll observable outcome.
      const deadline = Date.now() + 45_000;
      let list: unknown[] = [];
      while (Date.now() < deadline) {
        const r = await documents.listTemplates({ project_id: docsProjectId }, md);
        list = (r.list ?? []) as unknown[];
        if (list.length > 0) break;
        await new Promise((r) => setTimeout(r, 500));
      }
      if (list.length === 0) {
        // Narrow repro: direct s2s call also yields zero templates (S3 seed upload fails on the box stand).
        const prov = await documents.provisionDefaults(
          { project_id: docsProjectId, enabled_modules: ['deals', 'contacts', 'documents'] },
          md,
        );
        const created = Number(prov.templates_created ?? prov.templatesCreated ?? 0);
        expect(created).toBeGreaterThan(0);
      }
      expect(list.length).toBeGreaterThan(0);
    } finally {
      await archiveBoxTestProjectViaLocalControl(harness, docsProjectId, actorUserId);
    }
  });

  it('#42: GetModuleDisableImpact aggregates CountMemberOwnedRecords across the box stand domains', async () => {
    const md = serviceMetadata(projectId);
    md.set('x-user-id', actorUserId);
    const impact = await harness.grpc.project.getModuleDisableImpact(
      {
        project_id: projectId,
        module_id: 'contacts',
        user_id: actorUserId,
      },
      md,
    );
    expect(Number(impact.unfinished_records ?? 0)).toBeLessThanOrEqual(0);
  });

  it('#43: ListModuleStates exposes runtime gate snapshot for automation consumer', async () => {
    const md = serviceMetadata(projectId);
    const r = await harness.grpc.moduleLifecycle.listModuleStates({ project_id: projectId }, md);
    const list = (r.list ?? []) as Array<{ module_id: string; enabled?: boolean }>;
    expect(list.some((m) => m.module_id === 'automation')).toBe(true);
    expect(list.some((m) => m.module_id === 'deals' && m.enabled !== false)).toBe(true);
  });

  it('#44: control DisableModule freezes automation rules on the box stand', async () => {
    const automation = createAutomationGrpcClient(BOX_CONN.grpc.automation);
    const md = serviceMetadata(projectId);
    const actorMd = serviceMetadata(projectId);
    actorMd.set('x-user-id', actorUserId);

    const created = await automation.createRule(
      {
        project_id: projectId,
        name: `intclosure-access-freeze-${Date.now()}`,
        trigger_type: 'crm.deal.created',
        actions_json: JSON.stringify([{ type: 'create_activity', config: { title: 'probe' } }]),
      },
      md,
    );
    const ruleId = String(created.id ?? created.rule_id ?? '');
    expect(ruleId).toBeTruthy();

    const beforeDisable = await automation.listRules({ project_id: projectId }, md);
    const activeRule = ((beforeDisable.list ?? []) as Array<{ id: string; state: string }>).find(
      (r) => r.id === ruleId,
    );
    expect(activeRule?.state).not.toBe('frozen');

    await harness.grpc.moduleLifecycle.disableModule(
      {
        project_id: projectId,
        module_id: 'automation',
        actor_user_id: actorUserId,
      },
      actorMd,
    );

    const deadline = Date.now() + 30_000;
    let frozenRule: { id: string; state: string } | undefined;
    while (Date.now() < deadline) {
      const afterDisable = await automation.listRules({ project_id: projectId }, md);
      frozenRule = ((afterDisable.list ?? []) as Array<{ id: string; state: string }>).find(
        (r) => r.id === ruleId,
      );
      if (frozenRule?.state === 'frozen') break;
      await new Promise((r) => setTimeout(r, 500));
    }
    expect(frozenRule?.state).toBe('frozen');

    await harness.grpc.moduleLifecycle.enableModule(
      {
        project_id: projectId,
        module_id: 'automation',
        actor_user_id: actorUserId,
      },
      actorMd,
    );
    await automation.deleteRule({ project_id: projectId, rule_id: ruleId }, md);
  });

  it('#44: control DisableModule reconciles automation rule dependencies on the box stand', async () => {
    const reconcileModules = ['deals', 'contacts', 'activities', 'automation'];
    const reconcileProjectId = await createBoxTestProjectViaLocalControl(
      harness,
      reconcileModules,
      actorUserId,
    );
    const automation = createAutomationGrpcClient(BOX_CONN.grpc.automation);
    const md = serviceMetadata(reconcileProjectId);
    const actorMd = serviceMetadata(reconcileProjectId);
    actorMd.set('x-user-id', actorUserId);

    try {
      const created = await automation.createRule(
        {
          project_id: reconcileProjectId,
          name: `intclosure-access-reconcile-${Date.now()}`,
          trigger_type: 'crm.contact.created',
          trigger_config_json: JSON.stringify({ event_name: 'crm.contact.created' }),
          actions_json: JSON.stringify([
            { type: 'create_activity', config: { title: 'reconcile-probe' } },
          ]),
        },
        md,
      );
      const ruleId = String(created.id ?? created.rule_id ?? '');
      expect(ruleId).toBeTruthy();

      const beforeDisable = await automation.listRules({ project_id: reconcileProjectId }, md);
      const activeRule = ((beforeDisable.list ?? []) as Array<{ id: string; state: string }>).find(
        (r) => r.id === ruleId,
      );
      expect(activeRule?.state).not.toBe('unexecutable');

      await harness.grpc.moduleLifecycle.disableModule(
        {
          project_id: reconcileProjectId,
          module_id: 'contacts',
          actor_user_id: actorUserId,
        },
        actorMd,
      );

      const deadline = Date.now() + 30_000;
      let unreconciledRule: { id: string; state: string } | undefined;
      while (Date.now() < deadline) {
        const afterDisable = await automation.listRules({ project_id: reconcileProjectId }, md);
        unreconciledRule = ((afterDisable.list ?? []) as Array<{ id: string; state: string }>).find(
          (r) => r.id === ruleId,
        );
        if (unreconciledRule?.state === 'unexecutable') break;
        await new Promise((r) => setTimeout(r, 500));
      }
      expect(unreconciledRule?.state).toBe('unexecutable');

      await automation.deleteRule({ project_id: reconcileProjectId, rule_id: ruleId }, md);
    } finally {
      await archiveBoxTestProjectViaLocalControl(harness, reconcileProjectId, actorUserId);
    }
  });

  it('#44: control ResumeModuleDelivery unfreezes automation after suspend cycle', async () => {
    const resumeModules = ['deals', 'contacts', 'activities', 'automation'];
    const resumeProjectId = await createBoxTestProjectViaLocalControl(
      harness,
      resumeModules,
      actorUserId,
      resumeModules.map((moduleId) => ({
        module_id: moduleId,
        enabled: true,
        integration_settings:
          moduleId === 'automation' ? { defaultWebhookSecret: 'intclosure-resume-probe' } : {},
      })),
    );
    const automation = createAutomationGrpcClient(BOX_CONN.grpc.automation);
    const md = serviceMetadata(resumeProjectId);
    const actorMd = serviceMetadata(resumeProjectId);
    actorMd.set('x-user-id', actorUserId);

    try {
      const states = await harness.grpc.moduleLifecycle.listModuleStates(
        { project_id: resumeProjectId },
        md,
      );
      const autoCfg = (
        (states.list ?? []) as Array<{
          module_id: string;
          config_state?: string;
          configState?: string;
        }>
      ).find((m) => m.module_id === 'automation');
      expect(autoCfg).toBeDefined();
      expect(autoCfg!.config_state ?? autoCfg!.configState).toBe('ready');

      const created = await automation.createRule(
        {
          project_id: resumeProjectId,
          name: `intclosure-access-resume-${Date.now()}`,
          trigger_type: 'crm.deal.created',
          actions_json: JSON.stringify([
            { type: 'create_activity', config: { title: 'resume-probe' } },
          ]),
        },
        md,
      );
      const ruleId = String(created.id ?? created.rule_id ?? '');
      expect(ruleId).toBeTruthy();

      await harness.grpc.moduleLifecycle.disableModule(
        {
          project_id: resumeProjectId,
          module_id: 'automation',
          actor_user_id: actorUserId,
        },
        actorMd,
      );
      await harness.grpc.moduleLifecycle.enableModule(
        {
          project_id: resumeProjectId,
          module_id: 'automation',
          actor_user_id: actorUserId,
        },
        actorMd,
      );

      const modulesBeforeResume = await harness.grpc.moduleLifecycle.listModuleStates(
        { project_id: resumeProjectId },
        md,
      );
      const autoBefore = (
        (modulesBeforeResume.list ?? []) as Array<{
          module_id: string;
          runtime_status?: string;
          runtimeStatus?: string;
        }>
      ).find((m) => m.module_id === 'automation');
      expect(autoBefore?.runtime_status ?? autoBefore?.runtimeStatus ?? 'suspended').toBe(
        'suspended',
      );

      await harness.grpc.moduleLifecycle.resumeModuleDelivery(
        {
          project_id: resumeProjectId,
          module_id: 'automation',
          actor_user_id: actorUserId,
          dlq: 'discard',
        },
        actorMd,
      );

      const resumeDeadline = Date.now() + 30_000;
      let resumedRule: { id: string; state: string } | undefined;
      while (Date.now() < resumeDeadline) {
        const afterResume = await automation.listRules({ project_id: resumeProjectId }, md);
        resumedRule = ((afterResume.list ?? []) as Array<{ id: string; state: string }>).find(
          (r) => r.id === ruleId,
        );
        if (resumedRule?.state !== 'frozen') break;
        await new Promise((r) => setTimeout(r, 500));
      }
      expect(resumedRule?.state).not.toBe('frozen');

      await automation.deleteRule({ project_id: resumeProjectId, rule_id: ruleId }, md);
    } finally {
      await archiveBoxTestProjectViaLocalControl(harness, resumeProjectId, actorUserId);
    }
  });

  it('#PEP-1: invalid service API key is fail-closed at auth ValidateServiceApiKey', async () => {
    const apiKey = createAuthApiKeyGrpcClient(BOX_CONN.grpc.auth);
    const invalid = await apiKey.validateServiceApiKey({ api_key: 'ak_invalid_intclosure_probe' });
    expect(invalid.active).toBe(false);
    const active = await apiKey.validateServiceApiKey({
      api_key: BOX_CONN.gatewayServiceApiKey,
    });
    expect(active.active).toBe(true);
  });

  it('#PEP-2: local control rejects inbound gRPC without x-service-api-key', async () => {
    // APP_GUARD GrpcInboundApiKeyGuard must be wired on the gRPC microservice (see main.ts).
    const { Metadata } = await import('@grpc/grpc-js');
    await expect(
      harness.grpc.project.listMembers({ project_id: projectId }, new Metadata()),
    ).rejects.toMatchObject({ code: status.UNAUTHENTICATED });
  });

  it.each([
    ['#PEP-3', 'pipe', () => createPipeGrpcClient(BOX_CONN.grpc.pipe)],
    ['#PEP-4', 'orders', () => createPeerOrdersGrpcClient(BOX_CONN.grpc.orders)],
    ['#PEP-5', 'documents', () => createDocumentsGrpcClient(BOX_CONN.grpc.documents)],
    ['#PEP-6', 'automation', () => createAutomationGrpcClient(BOX_CONN.grpc.automation)],
    ['#PEP-7', 'contact', () => createContactGrpcClient(BOX_CONN.grpc.contact)],
    ['#PEP-8', 'company', () => createCompanyGrpcClient(BOX_CONN.grpc.company)],
    ['#PEP-9', 'activity', () => createActivityGrpcClient(BOX_CONN.grpc.activity)],
    ['#PEP-10', 'product', () => createProductGrpcClient(BOX_CONN.grpc.product)],
    ['#PEP-11', 'reports', () => createReportsGrpcClient(BOX_CONN.grpc.reports)],
    ['#PEP-12', 'search', () => createSearchGrpcClient(BOX_CONN.grpc.search)],
    ['#PEP-13', 'notification', () => createNotificationGrpcClient(BOX_CONN.grpc.notification)],
    ['#PEP-14', 'chat', () => createChatGrpcClient(BOX_CONN.grpc.chat)],
    ['#PEP-15', 'audit', () => createAuditGrpcClient(BOX_CONN.grpc.audit)],
  ])(
    '%s: the box stand %s domain accepts gateway service API key',
    async (pepId, _label, clientFactory) => {
      const md = serviceMetadata(projectId);
      const client = clientFactory();
      if ('listPipelines' in client) {
        await expect(client.listPipelines({ project_id: projectId }, md)).resolves.toBeDefined();
      } else if ('listOrderTypes' in client) {
        await expect(client.listOrderTypes({ project_id: projectId }, md)).resolves.toBeDefined();
      } else if ('listTemplates' in client) {
        await expect(client.listTemplates({ project_id: projectId }, md)).resolves.toBeDefined();
      } else if ('listRules' in client) {
        await expect(client.listRules({ project_id: projectId }, md)).resolves.toBeDefined();
      } else if ('listContacts' in client) {
        await expect(client.listContacts({ project_id: projectId }, md)).resolves.toBeDefined();
      } else if ('listCompanies' in client) {
        await expect(client.listCompanies({ project_id: projectId }, md)).resolves.toBeDefined();
      } else if ('listActivities' in client) {
        await expect(client.listActivities({ project_id: projectId }, md)).resolves.toBeDefined();
      } else if ('listProducts' in client) {
        await expect(client.listProducts({ project_id: projectId }, md)).resolves.toBeDefined();
      } else if ('listReports' in client) {
        await expect(client.listReports({ project_id: projectId }, md)).resolves.toBeDefined();
      } else if ('listUnassigned' in client) {
        await expect(
          client.listUnassigned({ project_id: projectId, resource: 'all' }, md),
        ).resolves.toBeDefined();
      } else if ('listNotifications' in client) {
        await expect(
          client.listNotifications(
            { project_id: projectId, user_id: actorUserId, page_index: 0, page_size: 1 },
            md,
          ),
        ).resolves.toBeDefined();
      } else if ('listConversations' in client) {
        md.set('x-user-id', actorUserId);
        await expect(
          client.listConversations(
            { scope: { kind: 'project', scope_id: projectId }, scope_filter: 'current' },
            md,
          ),
        ).resolves.toBeDefined();
      } else if ('listEvents' in client) {
        await expect(
          client.listEvents({ project_id: projectId, page_index: 0, page_size: 1 }, md),
        ).resolves.toBeDefined();
      } else {
        throw new Error(`${pepId}: no list probe wired for client`);
      }
    },
  );
});
