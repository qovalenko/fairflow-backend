import {
  assertMemberOffboardPeerWired,
  BOX_CONN,
  createBoxOwnedCompany,
  createBoxOwnedContact,
  createDocumentsGrpcClient,
  deactivateMember,
  describeBoxIntegration,
  ensureDocumentsProvisioned,
  serviceMetadata,
  setupOffboardFixture,
  teardownOffboardProject,
  waitFor,
  waitForPublishedTemplate,
  withIsolatedPurgeHarness,
} from '@fairflow/testing';

jest.setTimeout(180_000);

describeBoxIntegration('group-offboard member bugs (control local, peers on the box stand)', () => {
  it.skip('#46: BUG member offboarded reassigns contact ownerId to the chosen responsible', async () => {
    await withIsolatedPurgeHarness(async (ctx) => {
      const { projectId, employee } = await setupOffboardFixture(
        ctx.harness,
        ctx.gateway,
        'contact',
        ['contacts'],
      );
      try {
        const contactId = await createBoxOwnedContact(
          projectId,
          employee.userId,
          ctx.actorUserId,
          'contact-offboard',
        );
        const before = await ctx.mongo.findContact(projectId, contactId);
        expect(before?.ownerId).toBe(employee.userId);
        await deactivateMember(
          ctx.harness,
          employee.userId,
          ctx.actorUserId,
          ctx.actorUserId,
          projectId,
          ctx.postgres,
        );
        await assertMemberOffboardPeerWired('contact.member-offboarded');
        const after = await waitFor(
          async () => {
            const doc = await ctx.mongo.findContact(projectId, contactId);
            return doc?.ownerId === ctx.actorUserId ? doc : false;
          },
          { label: 'contact ownerId after offboard', timeoutMs: 90_000 },
        );
        expect(after?.ownerId).toBe(ctx.actorUserId);
      } finally {
        await teardownOffboardProject(ctx.harness, projectId, ctx.actorUserId).catch(
          () => undefined,
        );
      }
    });
  });

  it.skip('#47: BUG member offboarded reassigns company ownerId to the chosen responsible', async () => {
    await withIsolatedPurgeHarness(async (ctx) => {
      const { projectId, employee } = await setupOffboardFixture(
        ctx.harness,
        ctx.gateway,
        'company',
        ['companies'],
      );
      try {
        const companyId = await createBoxOwnedCompany(
          projectId,
          employee.userId,
          ctx.actorUserId,
          'company-offboard',
        );
        const before = await ctx.mongo.findCompany(projectId, companyId);
        expect(before?.ownerId).toBe(employee.userId);
        await deactivateMember(
          ctx.harness,
          employee.userId,
          ctx.actorUserId,
          ctx.actorUserId,
          projectId,
          ctx.postgres,
        );
        await assertMemberOffboardPeerWired('company.member-offboarded');
        const after = await waitFor(
          async () => {
            const doc = await ctx.mongo.findCompany(projectId, companyId);
            return doc?.ownerId === ctx.actorUserId ? doc : false;
          },
          { label: 'company ownerId after offboard', timeoutMs: 90_000 },
        );
        expect(after?.ownerId).toBe(ctx.actorUserId);
      } finally {
        await teardownOffboardProject(ctx.harness, projectId, ctx.actorUserId).catch(
          () => undefined,
        );
      }
    });
  });

  it.skip('#48: BUG member offboarded reassigns document group ownerId to the chosen responsible', async () => {
    await withIsolatedPurgeHarness(async (ctx) => {
      const { projectId, employee } = await setupOffboardFixture(
        ctx.harness,
        ctx.gateway,
        'documents',
        ['deals', 'documents'],
      );
      try {
        const dealId = await ctx.gateway.createDeal(projectId, {
          name: `deal-doc-offboard-${Date.now()}`,
          assigneeId: employee.userId,
        });
        await ensureDocumentsProvisioned(projectId, ['deals', 'documents']);
        const templateId = await waitForPublishedTemplate(projectId, 'deal', 120_000);
        const documents = createDocumentsGrpcClient(BOX_CONN.grpc.documents);
        const md = serviceMetadata(projectId);
        md.set('x-user-id', employee.userId);
        const generated = await documents.generateDocument(
          {
            project_id: projectId,
            template_id: templateId,
            context_type: 'deal',
            record_id: dealId,
          },
          md,
        );
        const groupId = String((generated.group as { id?: string })?.id ?? '');
        await deactivateMember(
          ctx.harness,
          employee.userId,
          ctx.actorUserId,
          ctx.actorUserId,
          projectId,
          ctx.postgres,
        );
        const after = await waitFor(
          async () => {
            const doc = await ctx.mongo.findDocumentGroup(projectId, groupId);
            return doc?.ownerId === ctx.actorUserId ? doc : false;
          },
          { label: 'document ownerId after offboard', timeoutMs: 90_000 },
        );
        expect(after?.ownerId).toBe(ctx.actorUserId);
      } finally {
        await teardownOffboardProject(ctx.harness, projectId, ctx.actorUserId).catch(
          () => undefined,
        );
      }
    });
  });
});
