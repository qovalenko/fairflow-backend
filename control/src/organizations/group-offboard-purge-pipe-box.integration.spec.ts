import {
  createOffboardTestProject,
  describeBoxIntegration,
  requestProjectPurge,
  waitForMongoEntityCount,
  waitForProjectCollectionPurged,
  withIsolatedPurgeHarness,
} from '@fairflow/testing';

jest.setTimeout(420_000);

describeBoxIntegration('group-offboard purge pipe (control local, peers on the box stand)', () => {
  it.skip('#50: BUG project purged drops pipe deals for the project', async () => {
    await withIsolatedPurgeHarness(async (ctx) => {
      const { projectId, projectName } = await createOffboardTestProject(
        ctx.harness,
        ctx.actorUserId,
        'purge-pipe',
        ['deals'],
      );
      await ctx.gateway.createDeal(projectId, { name: `deal-purge-${Date.now()}` });
      await waitForMongoEntityCount(ctx.mongo, 'crm_deals', projectId);
      await requestProjectPurge(ctx.harness, ctx.postgres, projectId, projectName, ctx.actorUserId);
      await waitForProjectCollectionPurged(ctx.mongo, 'crm_deals', projectId);
      expect(await ctx.mongo.countByProject('crm_deals', projectId)).toBe(0);
    });
  });
});
