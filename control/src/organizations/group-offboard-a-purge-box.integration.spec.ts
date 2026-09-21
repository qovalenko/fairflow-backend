import {
  describeBoxIntegration,
  ensureDocumentsProvisioned,
  createOffboardTestProject,
  requestProjectPurge,
  waitForMongoEntityCount,
  waitForProjectCollectionPurged,
  waitForPublishedTemplate,
  withIsolatedPurgeHarness,
} from '@fairflow/testing';

jest.setTimeout(420_000);

describeBoxIntegration('group-offboard purge bugs (control local, peers on the box stand)', () => {
  it.skip('#50: BUG project purged drops search index rows for the project', async () => {
    await withIsolatedPurgeHarness(async (ctx) => {
      const { projectId, projectName } = await createOffboardTestProject(
        ctx.harness,
        ctx.actorUserId,
        'purge-search',
        ['contacts', 'search'],
      );
      await ctx.gateway.createContact(projectId, {
        first_name: 'Purge',
        last_name: 'Search',
        email: `purge-search-${Date.now()}@example.com`,
      });
      await waitForMongoEntityCount(ctx.mongo, 'search_index', projectId, 1, 90_000);
      await requestProjectPurge(ctx.harness, ctx.postgres, projectId, projectName, ctx.actorUserId);
      await waitForProjectCollectionPurged(ctx.mongo, 'search_index', projectId);
      expect(await ctx.mongo.countByProject('search_index', projectId)).toBe(0);
    });
  });

  it.skip('#50: BUG project purged drops companies for the project', async () => {
    await withIsolatedPurgeHarness(async (ctx) => {
      const { projectId, projectName } = await createOffboardTestProject(
        ctx.harness,
        ctx.actorUserId,
        'purge-company',
        ['companies'],
      );
      await ctx.gateway.createCompany(projectId, {
        name: `co-purge-${Date.now()}`,
        inn: '7700000202',
      });
      await waitForMongoEntityCount(ctx.mongo, 'companies', projectId);
      await requestProjectPurge(ctx.harness, ctx.postgres, projectId, projectName, ctx.actorUserId);
      await waitForProjectCollectionPurged(ctx.mongo, 'companies', projectId);
      expect(await ctx.mongo.countByProject('companies', projectId)).toBe(0);
    });
  });

  it.skip('#50: BUG project purged drops document groups for the project', async () => {
    await withIsolatedPurgeHarness(async (ctx) => {
      const { projectId, projectName } = await createOffboardTestProject(
        ctx.harness,
        ctx.actorUserId,
        'purge-documents',
        ['deals', 'documents'],
      );
      const dealId = await ctx.gateway.createDeal(projectId, {
        name: `deal-purge-doc-${Date.now()}`,
      });
      await ensureDocumentsProvisioned(projectId, ['deals', 'documents']);
      const templateId = await waitForPublishedTemplate(projectId, 'deal', 120_000);
      await ctx.gateway.generateDocument(projectId, {
        templateId,
        contextType: 'deal',
        recordId: dealId,
      });
      await waitForMongoEntityCount(ctx.mongo, 'document_groups', projectId);
      await requestProjectPurge(ctx.harness, ctx.postgres, projectId, projectName, ctx.actorUserId);
      await waitForProjectCollectionPurged(ctx.mongo, 'document_groups', projectId);
      expect(await ctx.mongo.countByProject('document_groups', projectId)).toBe(0);
    });
  });
});
