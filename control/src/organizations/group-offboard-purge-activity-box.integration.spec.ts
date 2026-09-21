import {
  createOffboardTestProject,
  describeBoxIntegration,
  requestProjectPurge,
  waitForMongoEntityCount,
  waitForProjectCollectionPurged,
  withIsolatedPurgeHarness,
} from '@fairflow/testing';

jest.setTimeout(420_000);

describeBoxIntegration('group-offboard purge activity (control local, peers on the box stand)', () => {
  it.skip('#50: BUG project purged drops activities for the project', async () => {
    await withIsolatedPurgeHarness(async (ctx) => {
      const { projectId, projectName } = await createOffboardTestProject(
        ctx.harness,
        ctx.actorUserId,
        'purge-activity',
        ['activities'],
      );
      await ctx.gateway.createActivity(projectId, { title: `act-purge-${Date.now()}` });
      await waitForMongoEntityCount(ctx.mongo, 'crm_activities', projectId);
      await requestProjectPurge(ctx.harness, ctx.postgres, projectId, projectName, ctx.actorUserId);
      await waitForProjectCollectionPurged(ctx.mongo, 'crm_activities', projectId);
      expect(await ctx.mongo.countByProject('crm_activities', projectId)).toBe(0);
    });
  });
});
