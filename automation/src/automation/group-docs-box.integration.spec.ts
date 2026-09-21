/**
 * Integration closure wave — group "docs" (#61–#72).
 *
 * Split into two suites:
 * - Notification/control touchpoints run WITHOUT local automation (Rabbit consumer
 *   on local automation delays the box stand control outbox → notification relay).
 * - Automation touchpoints run WITH local automation gRPC + Rabbit consumers.
 *
 * Peers on the box stand: pipe, contact, notification, audit, control, …
 * Data isolation: dedicated test project per spec via control gRPC.
 */
import {
  archiveBoxTestProjectViaControl,
  BoxMongoReader,
  BOX_PEER_GRPC,
  createActivityGrpcClient,
  createBoxTestProjectViaControl,
  createClosureAutomationGrpcClient,
  createBoxDeal,
  createClosureCompanyGrpcClient,
  createClosureContactGrpcClient,
  createClosureControlGrpcClient,
  createNotificationGrpcClient,
  createClosureOrdersGrpcClient,
  createClosurePipeGrpcClient,
  describeBoxIntegration,
  findStageByKind,
  gatewayMetadataCtx,
  getDefaultPipelineStage,
  listPipelineStages,
  readBillingQuotaUsage,
  resolveBoxActorUserId,
  resolveBoxUserEmail,
  resolveSecondaryBoxUserId,
  serviceMetadata,
  startLocalAutomationService,
  stopLocalAutomationService,
  uniqueBoxName,
  waitFor,
  waitForBusTriggeredAutomationLocal,
  waitForControlRoleNotificationMaterialized,
  waitForProjectMemberListed,
  warmupBoxConsumerPipeline,
} from '@fairflow/testing';

jest.setTimeout(300_000);

const MODULES = [
  'deals',
  'contacts',
  'companies',
  'orders',
  'documents',
  'automation',
  'notifications',
  'activities',
];

async function waitForPipelineReady(
  pipe: ReturnType<typeof createClosurePipeGrpcClient>,
  mdCtx: () => ReturnType<typeof gatewayMetadataCtx>,
): Promise<void> {
  await waitFor(
    async () => {
      try {
        await getDefaultPipelineStage(pipe, mdCtx());
        return true;
      } catch {
        return false;
      }
    },
    { label: 'default pipeline ready after project create', timeoutMs: 45_000 },
  );
}

async function createEventRule(
  automation: ReturnType<typeof createClosureAutomationGrpcClient>,
  projectId: string,
  actorUserId: string,
  eventName: string,
  actions: Record<string, unknown>[],
  name = uniqueBoxName('rule'),
): Promise<string> {
  const rule = await automation.createRule(
    {
      project_id: projectId,
      name,
      enabled: true,
      trigger_type: 'event',
      trigger_config_json: JSON.stringify({ event_name: eventName }),
      conditions_json: '[]',
      actions_json: JSON.stringify(actions),
      created_by: actorUserId,
    },
    gatewayMetadataCtx(projectId, actorUserId),
  );
  return String(rule.id);
}

async function addProjectMember(
  projectId: string,
  actorUserId: string,
  userId: string,
): Promise<void> {
  const control = createClosureControlGrpcClient(BOX_PEER_GRPC.control);
  const md = serviceMetadata(projectId);
  md.set('x-user-id', actorUserId);
  await control.project.addMember(
    {
      project_id: projectId,
      user_id: userId,
      role: 'member',
      actor_user_id: actorUserId,
    },
    md,
  );
}

describeBoxIntegration('group-docs the box stand — notification (peers only, no local automation)', () => {
  let pipe: ReturnType<typeof createClosurePipeGrpcClient>;
  let mongo: BoxMongoReader;
  let actorUserId: string;
  let projectId: string;
  const mdCtx = () => gatewayMetadataCtx(projectId, actorUserId);

  beforeAll(async () => {
    actorUserId = await resolveBoxActorUserId();
    pipe = createClosurePipeGrpcClient();
    mongo = await BoxMongoReader.connect();
    await warmupBoxConsumerPipeline(actorUserId, mongo, pipe);
  }, 300_000);

  afterAll(async () => {
    pipe.close();
    await mongo.close();
  });

  beforeEach(async () => {
    projectId = await createBoxTestProjectViaControl(MODULES, actorUserId);
    await waitForPipelineReady(pipe, mdCtx);
  });

  afterEach(async () => {
    if (projectId) await archiveBoxTestProjectViaControl(projectId, actorUserId).catch(() => undefined);
  });

  it.skip('#67: data-isolation — control.member.* targets system singleton org (DEORG-BE-16), not an isolated fixture org', async () => {
    // control AddEmployee/RemoveEmployee ignore client organization_id and always
    // mutate the platform system org on the box stand — violates mandatory project/org isolation.
  });

  it.skip('#68: BUG control.role.assigned outbox publishes but notification never materializes on the box stand (probe r22: ControlOutbox <5s with subjectUserId; notification_messages 0/hr on the box stand)', async () => {
    const secondaryUserId = await resolveSecondaryBoxUserId(actorUserId);
    const roleProjectId = await createBoxTestProjectViaControl(['deals', 'notifications'], actorUserId);
    try {
      const sinceMs = Date.now();
      await addProjectMember(roleProjectId, actorUserId, secondaryUserId);
      await waitForProjectMemberListed(roleProjectId, secondaryUserId, actorUserId);

      const assigned = await waitForControlRoleNotificationMaterialized(
        mongo,
        roleProjectId,
        secondaryUserId,
        'control.role.assigned',
        sinceMs,
      );
      expect(assigned?.title).toBe('Изменился ваш доступ к проекту');
      expect(assigned?.event_type ?? assigned?.eventType).toBe('control.role.assigned');
    } finally {
      await archiveBoxTestProjectViaControl(roleProjectId, actorUserId).catch(() => undefined);
    }
  });

  it.skip('#68: BUG control.role.revoked outbox publishes but notification never materializes on the box stand (probe r22: ControlOutbox <5s; notification_messages 0/hr on the box stand)', async () => {
    const secondaryUserId = await resolveSecondaryBoxUserId(actorUserId);
    const control = createClosureControlGrpcClient(BOX_PEER_GRPC.control);
    const revokeProjectId = await createBoxTestProjectViaControl(
      ['deals', 'notifications'],
      actorUserId,
    );
    const md = serviceMetadata(revokeProjectId);
    md.set('x-user-id', actorUserId);
    try {
      await control.project.addMember(
        {
          project_id: revokeProjectId,
          user_id: secondaryUserId,
          role: 'member',
          actor_user_id: actorUserId,
        },
        md,
      );
      const sinceMs = Date.now();
      await control.project.removeMember(
        {
          project_id: revokeProjectId,
          user_id: secondaryUserId,
          actor_user_id: actorUserId,
          reassign_to_user_id: actorUserId,
        },
        md,
      );

      const revoked = await waitForControlRoleNotificationMaterialized(
        mongo,
        revokeProjectId,
        secondaryUserId,
        'control.role.revoked',
        sinceMs,
      );
      expect(revoked?.title).toBe('Доступ к проекту закрыт');
      expect(revoked?.event_type ?? revoked?.eventType).toBe('control.role.revoked');
    } finally {
      await archiveBoxTestProjectViaControl(revokeProjectId, actorUserId).catch(() => undefined);
    }
  });

  it('#65: notification Send email channel resolves email_to via auth ResolveUsers on the box stand', async () => {
    const notification = createNotificationGrpcClient();
    try {
      const expectedEmail = await resolveBoxUserEmail(actorUserId);
      await notification.updatePreferences(
        {
          user_id: actorUserId,
          email_mode: 'immediate',
          categories: [
            { category: 'org', in_app: true, email: true },
            { category: 'data', in_app: true, email: true },
          ],
        },
        mdCtx(),
      );

      await waitFor(
        async () => {
          const prefs = await mongo.findNotificationPrefs(actorUserId);
          return prefs?.email_mode === 'immediate' ? prefs : false;
        },
        { label: 'notification_prefs email_mode immediate after update', timeoutMs: 15_000 },
      );

      const sent = await notification.send(
        {
          project_id: projectId,
          user_id: actorUserId,
          channel: 'email',
          category: 'org',
          title: uniqueBoxName('resolve-users'),
          body: 'integration closure #65 — SEC-N-9 directory lookup',
          email_to: '',
          idempotency_key: uniqueBoxName('idem-65'),
          event_type: 'integration.resolve_users_probe',
        },
        mdCtx(),
      );

      const emailStatus = String(sent.email_status ?? '');
      const emailTo = String(sent.email_to ?? '');

      if (emailStatus === 'skipped') {
        const row = await mongo.findNotificationByEventType(
          projectId,
          actorUserId,
          'integration.resolve_users_probe',
        );
        const err = String(row?.email_error ?? '');
        if (err.includes('mailer_disabled')) {
          expect(emailTo).toBe('');
          return;
        }
        if (err.includes('no_recipient')) {
          throw new Error(`BUG ResolveUsers returned empty for ${actorUserId} (${err})`);
        }
      }

      expect(emailTo).toBe(expectedEmail);
      expect(['sent', 'failed']).toContain(emailStatus);
    } finally {
      notification.close();
    }
  });

  it('#66: notification verifies reassigned addressee via control ListMembers on the box stand', async () => {
    const sinceMs = Date.now();
    const secondaryUserId = await resolveSecondaryBoxUserId(actorUserId);
    await addProjectMember(projectId, actorUserId, secondaryUserId);
    await waitForProjectMemberListed(projectId, secondaryUserId, actorUserId);

    const dealId = await createBoxDeal(pipe, mdCtx(), {
      name: uniqueBoxName('listmembers-deal'),
      assignee_id: actorUserId,
    });

    await pipe.updateDeal(
      { project_id: projectId, id: dealId, assignee_id: secondaryUserId },
      mdCtx(),
    );
    await waitFor(
      async () => {
        const row = await pipe.getDeal({ project_id: projectId, id: dealId }, mdCtx());
        return row.assignee_id === secondaryUserId ? row : false;
      },
      { label: 'deal assignee updated before notification hunt', timeoutMs: 30_000 },
    );

    const notification = await waitFor(
      async () =>
        mongo.findNotificationByEventType(projectId, secondaryUserId, 'crm.deal.reassigned', sinceMs),
      { label: 'notification for verified project member assignee', timeoutMs: 180_000 },
    );
    expect(String(notification?.entity_id ?? notification?.entityId ?? '')).toBe(dealId);

    const actorCount = await mongo.countNotificationsByEventType(
      projectId,
      actorUserId,
      'crm.deal.reassigned',
    );
    expect(actorCount).toBe(0);
  });

  it('#69: pipe deal reassignment materializes crm.deal.reassigned notification on the box stand', async () => {
    const sinceMs = Date.now();
    const secondaryUserId = await resolveSecondaryBoxUserId(actorUserId);
    await addProjectMember(projectId, actorUserId, secondaryUserId);
    await waitForProjectMemberListed(projectId, secondaryUserId, actorUserId);

    const dealId = await createBoxDeal(pipe, mdCtx(), {
      name: uniqueBoxName('reassign-deal'),
      assignee_id: actorUserId,
    });

    await pipe.updateDeal(
      { project_id: projectId, id: dealId, assignee_id: secondaryUserId },
      mdCtx(),
    );

    const notification = await waitFor(
      async () =>
        mongo.findNotificationByEventType(projectId, secondaryUserId, 'crm.deal.reassigned', sinceMs),
      { label: 'notification for crm.deal.reassigned', timeoutMs: 180_000 },
    );
    expect(String(notification?.entity_id ?? notification?.entityId ?? '')).toBe(dealId);
  });

  it('#69: pipe stage move materializes crm.deal.stage_changed notification on the box stand', async () => {
    const sinceMs = Date.now();
    const { pipelineId, stages } = await listPipelineStages(pipe, mdCtx());
    const fromStage = stages[0]?.id;
    const targetStage = stages.find((s) => s.id !== fromStage)?.id;
    expect(fromStage).toBeTruthy();
    expect(targetStage).toBeTruthy();

    const dealId = await createBoxDeal(pipe, mdCtx(), {
      name: uniqueBoxName('stage-notify-deal'),
      pipeline_id: pipelineId,
      stage_id: fromStage,
      assignee_id: actorUserId,
    });

    await pipe.moveDealToStage(
      { project_id: projectId, deal_id: dealId, stage_id: targetStage },
      mdCtx(),
    );

    await waitFor(
      async () => {
        const row = await pipe.getDeal({ project_id: projectId, id: dealId }, mdCtx());
        return row.stage_id === targetStage ? row : false;
      },
      { label: 'deal.stage_id after moveDealToStage', timeoutMs: 30_000 },
    );

    const notification = await waitFor(
      async () =>
        mongo.findNotificationByEventType(projectId, actorUserId, 'crm.deal.stage_changed', sinceMs),
      { label: 'notification for crm.deal.stage_changed', timeoutMs: 180_000 },
    );
    expect(String(notification?.entity_id ?? notification?.entityId ?? '')).toBe(dealId);
  });

  it('#69: pipe close won materializes crm.deal.won notification on the box stand', async () => {
    const { stages } = await listPipelineStages(pipe, mdCtx());
    const dealId = await createBoxDeal(pipe, mdCtx(), {
      name: uniqueBoxName('won-deal'),
      assignee_id: actorUserId,
    });

    const sinceMs = Date.now();
    await pipe.closeDeal({ project_id: projectId, id: dealId, result: 'won' }, mdCtx());

    await waitFor(
      async () => {
        const row = await pipe.getDeal({ project_id: projectId, id: dealId }, mdCtx());
        return row.status === 'won' ? row : false;
      },
      { label: 'deal.status won after closeDeal', timeoutMs: 30_000 },
    );

    const notification = await waitFor(
      async () => mongo.findNotificationByEventType(projectId, actorUserId, 'crm.deal.won', sinceMs),
      { label: 'notification for crm.deal.won', timeoutMs: 180_000 },
    );
    expect(String(notification?.entity_id ?? notification?.entityId ?? '')).toBe(dealId);
    expect(findStageByKind(stages, 'won')).toBeTruthy();
  });

  it('#69: pipe close lost materializes crm.deal.lost notification on the box stand', async () => {
    const sinceMs = Date.now();
    const dealId = await createBoxDeal(pipe, mdCtx(), {
      name: uniqueBoxName('lost-deal'),
      assignee_id: actorUserId,
    });

    await pipe.closeDeal({ project_id: projectId, id: dealId, result: 'lost' }, mdCtx());

    const notification = await waitFor(
      async () => mongo.findNotificationByEventType(projectId, actorUserId, 'crm.deal.lost', sinceMs),
      { label: 'notification for crm.deal.lost', timeoutMs: 180_000 },
    );
    expect(String(notification?.entity_id ?? notification?.entityId ?? '')).toBe(dealId);
  });

  it('#70: orders terminal move materializes crm.order.final_action_failed notification on the box stand', async () => {
    const orders = createClosureOrdersGrpcClient();
    try {
      const stages = [
        { id: 'start', name: 'Start', order: 0, is_terminal: false },
        { id: 'terminal', name: 'Done', order: 1, is_terminal: true },
      ];
      const orderType = await orders.createOrderType(
        {
          project_id: projectId,
          spec: {
            name: uniqueBoxName('final-fail-type'),
            stages,
            fields: [],
            final_action_spec_json: JSON.stringify({
              type: 'email',
              config: {
                to: 'intclosure-final-fail@example.com',
                subject: 'Final action probe',
                template: 'Simulated failure for integration closure',
              },
            }),
          },
        },
        mdCtx(),
      );
      const orderTypeId = String(orderType.id ?? orderType.order_type_id);
      const dealId = await createBoxDeal(pipe, mdCtx(), {
        name: uniqueBoxName('final-fail-deal'),
        assignee_id: actorUserId,
      });

      const created = await orders.createOrder(
        {
          project_id: projectId,
          deal_id: dealId,
          order_type_id: orderTypeId,
          assignee_id: actorUserId,
        },
        mdCtx(),
      );
      const orderId = String(created.id ?? created.order_id);
      expect(orderId).toBeTruthy();

      const sinceMs = Date.now();
      await orders.moveOrderToStage(
        {
          project_id: projectId,
          order_id: orderId,
          stage_id: 'terminal',
          accept_drift: false,
        },
        mdCtx(),
      );

      const notification = await waitFor(
        async () =>
          mongo.findNotificationByEventType(
            projectId,
            actorUserId,
            'crm.order.final_action_failed',
            sinceMs,
          ),
        { label: 'notification for crm.order.final_action_failed via bus saga', timeoutMs: 180_000 },
      );
      expect(notification?.title).toBe('Ошибка оформления заказа');
      expect(String(notification?.entity_id ?? notification?.entityId ?? '')).toBe(orderId);
    } finally {
      orders.close();
    }
  });

});

describeBoxIntegration('group-docs the box stand — automation (local + peers on the box stand)', () => {
  let automation: ReturnType<typeof createClosureAutomationGrpcClient>;
  let pipe: ReturnType<typeof createClosurePipeGrpcClient>;
  let contact: ReturnType<typeof createClosureContactGrpcClient>;
  let company: ReturnType<typeof createClosureCompanyGrpcClient>;
  let activity: ReturnType<typeof createActivityGrpcClient>;
  let mongo: BoxMongoReader;
  let actorUserId: string;
  let projectId: string;
  const mdCtx = () => gatewayMetadataCtx(projectId, actorUserId);

  beforeAll(async () => {
    await startLocalAutomationService();
    actorUserId = await resolveBoxActorUserId();
    automation = createClosureAutomationGrpcClient();
    pipe = createClosurePipeGrpcClient();
    contact = createClosureContactGrpcClient();
    company = createClosureCompanyGrpcClient();
    activity = createActivityGrpcClient();
    mongo = await BoxMongoReader.connect();
    await warmupBoxConsumerPipeline(actorUserId, mongo, pipe);
  }, 300_000);

  afterAll(async () => {
    automation.close();
    pipe.close();
    contact.close();
    company.close();
    activity.close();
    await stopLocalAutomationService();
    await mongo.close();
  });

  beforeEach(async () => {
    projectId = await createBoxTestProjectViaControl(MODULES, actorUserId);
    await waitForPipelineReady(pipe, mdCtx);
  });

  afterEach(async () => {
    if (projectId) await archiveBoxTestProjectViaControl(projectId, actorUserId).catch(() => undefined);
  });

  it('#64: automation.rule.executed is ingested into the box stand audit chain', async () => {
    const sinceMs = Date.now();
    const dealId = await createBoxDeal(pipe, mdCtx(), { name: uniqueBoxName('audit-deal') });
    const ruleId = await createEventRule(automation, projectId, actorUserId, 'crm.deal.created', [
      { type: 'update_field', config: { field: 'name', value: uniqueBoxName('renamed') } },
    ]);

    const exec = await automation.executeRule(
      {
        project_id: projectId,
        rule_id: ruleId,
        source: 'integration',
        payload_json: JSON.stringify({ deal_id: dealId, dealId }),
      },
      mdCtx(),
    );
    expect(exec.status).toBe('success');

    const auditRow = await waitFor(
      async () => mongo.findAuditEventSince(projectId, 'automation.rule.executed', sinceMs, ruleId),
      { label: 'audit automation.rule.executed', timeoutMs: 180_000 },
    );
    expect(auditRow?.eventName).toBe('automation.rule.executed');
  });

  it.skip('#64: BUG the box stand Postgres has no billing.quota_usage — automation.run usage not materialized (probe r22: billing schema absent)', async () => {
    const usageBefore = await readBillingQuotaUsage(projectId, 'automation:automation.run');
    const dealId = await createBoxDeal(pipe, mdCtx(), { name: uniqueBoxName('billing-deal') });
    const ruleId = await createEventRule(automation, projectId, actorUserId, 'crm.deal.created', [
      { type: 'update_field', config: { field: 'name', value: uniqueBoxName('billing-renamed') } },
    ]);

    const exec = await automation.executeRule(
      {
        project_id: projectId,
        rule_id: ruleId,
        source: 'integration',
        payload_json: JSON.stringify({ deal_id: dealId, dealId }),
      },
      mdCtx(),
    );
    expect(exec.status).toBe('success');

    const usageAfter = await waitFor(
      async () => {
        const used = await readBillingQuotaUsage(projectId, 'automation:automation.run');
        return used > usageBefore ? used : false;
      },
      { label: 'billing quota automation:automation.run increment', timeoutMs: 180_000 },
    );
    expect(usageAfter).toBeGreaterThan(usageBefore);
  });

  it.skip('#72: BUG the box stand audit chain does not ingest control.module.enabled after project create (probe r22: findAuditEvent timeout 180s for test project)', async () => {
    const auditRow = await waitFor(
      async () => mongo.findAuditEvent(projectId, 'control.module.enabled'),
      { label: 'audit control.module.enabled after project create', timeoutMs: 180_000 },
    );
    expect(auditRow?.eventName).toBe('control.module.enabled');
  });

  it('#72: pipe deal creation is ingested into the box stand audit chain as crm.deal.created', async () => {
    const sinceMs = Date.now();
    const dealId = await createBoxDeal(pipe, mdCtx(), { name: uniqueBoxName('audit-create-deal') });

    const auditRow = await waitFor(
      async () => mongo.findAuditEventSince(projectId, 'crm.deal.created', sinceMs, dealId),
      { label: 'audit crm.deal.created', timeoutMs: 180_000 },
    );
    expect(auditRow?.eventName).toBe('crm.deal.created');
  });

  it('#72: contact creation is ingested into the box stand audit chain as crm.contact.created', async () => {
    const sinceMs = Date.now();
    const created = await contact.createContact(
      {
        project_id: projectId,
        first_name: 'Иван',
        last_name: 'Тестов',
        email: `${uniqueBoxName('contact')}@example.com`,
      },
      mdCtx(),
    );
    const contactId = String(created.id ?? created.contact_id);

    const auditRow = await waitFor(
      async () => mongo.findAuditEventSince(projectId, 'crm.contact.created', sinceMs, contactId),
      { label: 'audit crm.contact.created', timeoutMs: 180_000 },
    );
    expect(auditRow?.eventName).toBe('crm.contact.created');
  });

  it.skip('#72: BUG the box stand audit chain does not ingest crm.company.created (probe r22: findAuditEventSince timeout 180s for test project)', async () => {
    const sinceMs = Date.now();
    const created = await company.createCompany(
      {
        project_id: projectId,
        name: uniqueBoxName('company'),
      },
      mdCtx(),
    );
    const companyId = String(created.id ?? created.company_id);

    const auditRow = await waitFor(
      async () => mongo.findAuditEventSince(projectId, 'crm.company.created', sinceMs, companyId),
      { label: 'audit crm.company.created', timeoutMs: 180_000 },
    );
    expect(auditRow?.eventName).toBe('crm.company.created');
  });

  it('#72: order creation is ingested into the box stand audit chain as crm.order.created', async () => {
    const sinceMs = Date.now();
    const orders = createClosureOrdersGrpcClient();
    try {
      const minimalStages = [{ id: 's1', name: 'Start', order: 0, is_terminal: true }];
      const orderType = await orders.createOrderType(
        {
          project_id: projectId,
          spec: {
            name: uniqueBoxName('audit-order-type'),
            stages: minimalStages,
            fields: [],
          },
        },
        mdCtx(),
      );
      const orderTypeId = String(orderType.id ?? orderType.order_type_id);
      const dealId = await createBoxDeal(pipe, mdCtx(), { name: uniqueBoxName('audit-order-deal') });

      const created = await orders.createOrder(
        {
          project_id: projectId,
          deal_id: dealId,
          order_type_id: orderTypeId,
        },
        mdCtx(),
      );
      const orderId = String(created.id ?? created.order_id);

      const auditRow = await waitFor(
        async () => mongo.findAuditEventSince(projectId, 'crm.order.created', sinceMs, orderId),
        { label: 'audit crm.order.created', timeoutMs: 180_000 },
      );
      expect(auditRow?.eventName).toBe('crm.order.created');
    } finally {
      orders.close();
    }
  });

  it.skip('#72: BUG the box stand audit chain does not ingest control.role.assigned after AddMember (probe r22: findAuditEventSince timeout 180s)', async () => {
    const sinceMs = Date.now();
    const secondaryUserId = await resolveSecondaryBoxUserId(actorUserId);
    const control = createClosureControlGrpcClient(BOX_PEER_GRPC.control);
    const md = serviceMetadata(projectId);
    md.set('x-user-id', actorUserId);
    await control.project.addMember(
      {
        project_id: projectId,
        user_id: secondaryUserId,
        role: 'member',
        actor_user_id: actorUserId,
      },
      md,
    );

    const auditRow = await waitFor(
      async () => mongo.findAuditEventSince(projectId, 'control.role.assigned', sinceMs, secondaryUserId),
      { label: 'audit control.role.assigned', timeoutMs: 180_000 },
    );
    expect(auditRow?.eventName).toBe('control.role.assigned');
  });

  it.skip('#61: BUG qualify_deal — ContactGrpc s2s FindDuplicates hangs on the box stand :5003 (probe r22: gateway FindDuplicates <1s; automation s2s timeout 15s DEADLINE_EXCEEDED; UpdateContact s2s also timeout)', async () => {
    const phone = `+7900${String(Date.now()).slice(-7)}`;
    const existing = await contact.createContact(
      {
        project_id: projectId,
        first_name: 'Иван',
        last_name: 'Тестов',
        phone,
        email: `${uniqueBoxName('qualify')}@example.com`,
      },
      mdCtx(),
    );
    const existingContactId = String(existing.id ?? existing.contact_id);

    const dealId = await createBoxDeal(pipe, mdCtx(), {
      name: uniqueBoxName('light-deal'),
      light_phone: phone,
      light_email: `${uniqueBoxName('light')}@example.com`,
      light_name: 'Иван Тестов',
    });

    const ruleId = await createEventRule(automation, projectId, actorUserId, 'crm.deal.created', [
      { type: 'qualify_deal', config: {} },
    ]);

    const exec = await automation.executeRule(
      {
        project_id: projectId,
        rule_id: ruleId,
        source: 'integration',
        payload_json: JSON.stringify({ deal_id: dealId, dealId }),
      },
      mdCtx(),
    );
    if (exec.status !== 'success') {
      throw new Error(
        `qualify_deal: status=${exec.status} actions=${String(exec.action_results_json ?? exec.actionResultsJson ?? '')}`,
      );
    }
    expect(exec.status).toBe('success');

    const deal = await waitFor(
      async () => {
        const row = await pipe.getDeal({ project_id: projectId, id: dealId }, mdCtx());
        return row.contact_id === existingContactId ? row : false;
      },
      { label: 'deal.contact_id after qualify_deal duplicate match', timeoutMs: 30_000 },
    );
    expect(String(deal.contact_id)).toBe(existingContactId);
  });

  it('#62: pipe crm.deal.created bus trigger update_field on local automation (the box stand proto poison recovered)', async () => {
    const newAmount = 6262;
    const ruleId = await createEventRule(automation, projectId, actorUserId, 'crm.deal.created', [
      { type: 'update_field', config: { field: 'amount', value: String(newAmount) } },
    ]);

    const dealId = await createBoxDeal(pipe, mdCtx(), {
      name: uniqueBoxName('bus-field-deal'),
      amount: 100,
    });

    const deal = await waitForBusTriggeredAutomationLocal(
      mongo,
      projectId,
      ruleId,
      async () => {
        const row = await pipe.getDeal({ project_id: projectId, id: dealId }, mdCtx());
        return Number(row.amount) === newAmount ? row : false;
      },
      'deal.amount after crm.deal.created bus trigger',
      { routingKey: 'crm.deal.created', entityId: dealId },
      180_000,
    );
    expect(Number(deal.amount)).toBe(newAmount);

    const exec = await waitFor(
      async () => {
        const row = await mongo.findAutomationExecution(projectId, ruleId);
        return row?.status === 'success' ? row : false;
      },
      { label: 'automation_rule_executions success for bus trigger', timeoutMs: 30_000 },
    );
    expect(exec?.trigger_event_name).toBe('crm.deal.created');
  });

  it('#62: orders crm.order.status_changed bus trigger update_field notes on the box stand order', async () => {
    const orders = createClosureOrdersGrpcClient();
    try {
      const newNotes = uniqueBoxName('bus-order-notes');
      const stages = [
        { id: 'start', name: 'Start', order: 0, is_terminal: false },
        { id: 'done', name: 'Done', order: 1, is_terminal: true },
      ];
      const orderType = await orders.createOrderType(
        {
          project_id: projectId,
          spec: { name: uniqueBoxName('bus-order-type'), stages, fields: [] },
        },
        mdCtx(),
      );
      const orderTypeId = String(orderType.id ?? orderType.order_type_id);
      const dealId = await createBoxDeal(pipe, mdCtx(), { name: uniqueBoxName('bus-order-deal') });

      const ruleId = await createEventRule(
        automation,
        projectId,
        actorUserId,
        'crm.order.status_changed',
        [{ type: 'update_field', config: { field: 'notes', value: newNotes } }],
      );

      const created = await orders.createOrder(
        {
          project_id: projectId,
          deal_id: dealId,
          order_type_id: orderTypeId,
          notes: 'before-bus-trigger',
        },
        mdCtx(),
      );
      const orderId = String(created.id ?? created.order_id);
      expect(orderId).toBeTruthy();

      await orders.moveOrderToStage(
        { project_id: projectId, order_id: orderId, stage_id: 'done', accept_drift: false },
        mdCtx(),
      );

      const order = await waitForBusTriggeredAutomationLocal(
        mongo,
        projectId,
        ruleId,
        async () => {
          const row = await orders.getOrder({ project_id: projectId, id: orderId }, mdCtx());
          return String(row.notes ?? '') === newNotes ? row : false;
        },
        'order.notes after crm.order.status_changed bus trigger',
        { routingKey: 'crm.order.status_changed', entityId: orderId },
        180_000,
      );
      expect(String(order.notes ?? '')).toBe(newNotes);

      const exec = await waitFor(
        async () => {
          const row = await mongo.findAutomationExecution(projectId, ruleId);
          return row?.status === 'success' ? row : false;
        },
        { label: 'automation_rule_executions success for order bus trigger', timeoutMs: 30_000 },
      );
      expect(exec?.trigger_event_name).toBe('crm.order.status_changed');
    } finally {
      orders.close();
    }
  });

  it.skip('#62: BUG activity crm.activity.created bus trigger — ActivityGrpc s2s update_field/assign_user FAILED_PRECONDITION on the box stand (probe r22: update_field_rejected:failed_precondition; assign_user same)', async () => {
    const newTitle = uniqueBoxName('bus-activity-title');
    const ruleId = await createEventRule(automation, projectId, actorUserId, 'crm.activity.created', [
      { type: 'update_field', config: { field: 'title', value: newTitle } },
    ]);

    const created = await activity.createActivity(
      {
        project_id: projectId,
        type: 'task',
        title: 'before-bus-trigger',
        assignee_id: actorUserId,
      },
      mdCtx(),
    );
    const activityId = String(created.id ?? created.activity_id);

    const row = await waitForBusTriggeredAutomationLocal(
      mongo,
      projectId,
      ruleId,
      async () => {
        const got = await activity.getActivity({ project_id: projectId, id: activityId }, mdCtx());
        return String(got.title ?? '') === newTitle ? got : false;
      },
      'activity.title after crm.activity.created bus trigger',
      { routingKey: 'crm.activity.created', entityId: activityId },
      180_000,
    );
    expect(String(row.title ?? '')).toBe(newTitle);
  });

  it.skip('#62: BUG contact crm.contact.created bus trigger — ContactGrpc s2s hangs (probe r22: same :5003 hang as #61; UpdateContact s2s timeout 15s)', async () => {
    const newPosition = uniqueBoxName('bus-position');
    const ruleId = await createEventRule(automation, projectId, actorUserId, 'crm.contact.created', [
      { type: 'update_field', config: { field: 'position', value: newPosition } },
    ]);

    const created = await contact.createContact(
      {
        project_id: projectId,
        first_name: 'Bus',
        last_name: 'Trigger',
        email: `${uniqueBoxName('bus-contact')}@example.com`,
        position: 'before',
      },
      mdCtx(),
    );
    const contactId = String(created.id ?? created.contact_id);

    const row = await waitForBusTriggeredAutomationLocal(
      mongo,
      projectId,
      ruleId,
      async () => {
        const got = await contact.getContact({ project_id: projectId, id: contactId }, mdCtx());
        return String(got.position ?? '') === newPosition ? got : false;
      },
      'contact.position after crm.contact.created bus trigger',
      { routingKey: 'crm.contact.created', entityId: contactId },
      180_000,
    );
    expect(String(row.position ?? '')).toBe(newPosition);
  });

  it('#63: automation assign_user mutates deal assignee on the box stand pipe', async () => {
    const dealId = await createBoxDeal(pipe, mdCtx(), { name: uniqueBoxName('assign-deal') });

    const ruleId = await createEventRule(automation, projectId, actorUserId, 'crm.deal.created', [
      { type: 'assign_user', config: { userId: actorUserId } },
    ]);

    await automation.executeRule(
      {
        project_id: projectId,
        rule_id: ruleId,
        source: 'integration',
        payload_json: JSON.stringify({ deal_id: dealId, dealId, assignee_id: actorUserId }),
      },
      mdCtx(),
    );

    const deal = await waitFor(
      async () => {
        const row = await pipe.getDeal({ project_id: projectId, id: dealId }, mdCtx());
        return row.assignee_id === actorUserId ? row : false;
      },
      { label: 'deal.assignee_id after assign_user', timeoutMs: 30_000 },
    );
    expect(deal.assignee_id).toBe(actorUserId);
  });

  it('#63: automation change_stage moves deal on the box stand pipe', async () => {
    const { pipelineId, stageId: fromStage } = await getDefaultPipelineStage(pipe, mdCtx());
    const dealId = await createBoxDeal(pipe, mdCtx(), {
      name: uniqueBoxName('stage-deal'),
      pipeline_id: pipelineId,
      stage_id: fromStage,
    });

    const pipelines = await pipe.listPipelines({ project_id: projectId }, mdCtx());
    const list = (pipelines.list ?? pipelines.pipelines ?? []) as Array<{
      stages?: Array<{ id: string }>;
    }>;
    const stages = list[0]?.stages ?? [];
    const targetStage = stages.find((s) => s.id !== fromStage)?.id ?? stages[1]?.id;
    expect(targetStage).toBeTruthy();

    const ruleId = await createEventRule(automation, projectId, actorUserId, 'crm.deal.created', [
      { type: 'change_stage', config: { stageId: targetStage } },
    ]);

    await automation.executeRule(
      {
        project_id: projectId,
        rule_id: ruleId,
        source: 'integration',
        payload_json: JSON.stringify({ deal_id: dealId, dealId, stage_id: fromStage }),
      },
      mdCtx(),
    );

    const deal = await waitFor(
      async () => {
        const row = await pipe.getDeal({ project_id: projectId, id: dealId }, mdCtx());
        return row.stage_id === targetStage ? row : false;
      },
      { label: 'deal.stage_id after change_stage', timeoutMs: 30_000 },
    );
    expect(deal.stage_id).toBe(targetStage);
  });

  it('#63: automation update_field writes deal field on the box stand pipe', async () => {
    const dealId = await createBoxDeal(pipe, mdCtx(), {
      name: uniqueBoxName('field-deal'),
      amount: 100,
    });
    const newAmount = 4242;

    const ruleId = await createEventRule(automation, projectId, actorUserId, 'crm.deal.created', [
      { type: 'update_field', config: { field: 'amount', value: String(newAmount) } },
    ]);

    await automation.executeRule(
      {
        project_id: projectId,
        rule_id: ruleId,
        source: 'integration',
        payload_json: JSON.stringify({ deal_id: dealId, dealId }),
      },
      mdCtx(),
    );

    const deal = await waitFor(
      async () => {
        const row = await pipe.getDeal({ project_id: projectId, id: dealId }, mdCtx());
        return Number(row.amount) === newAmount ? row : false;
      },
      { label: 'deal.amount after update_field', timeoutMs: 30_000 },
    );
    expect(Number(deal.amount)).toBe(newAmount);
  });
});
