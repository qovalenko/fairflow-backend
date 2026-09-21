import {
  createOffboardTestProject,
  describeBoxIntegration,
  requestProjectPurge,
  waitForMongoEntityCount,
  waitForProjectCollectionPurged,
  withIsolatedPurgeHarness,
} from '@fairflow/testing';

jest.setTimeout(420_000);

describeBoxIntegration('group-offboard purge orders (control local, peers on the box stand)', () => {
  it.skip('#50: BUG project purged drops orders for the project', async () => {
    await withIsolatedPurgeHarness(async (ctx) => {
      const { projectId, projectName } = await createOffboardTestProject(
        ctx.harness,
        ctx.actorUserId,
        'purge-orders',
        ['orders'],
      );
      const orderId = await ctx.gateway.createOrder(projectId, {
        title: `ord-purge-${Date.now()}`,
      });
      await waitForMongoEntityCount(ctx.mongo, 'crm_orders', projectId);
      const beforeOrder = await ctx.mongo.findOrder(projectId, orderId);
      expect(beforeOrder).toBeTruthy();
      await requestProjectPurge(ctx.harness, ctx.postgres, projectId, projectName, ctx.actorUserId);
      await waitForProjectCollectionPurged(ctx.mongo, 'crm_orders', projectId);
      expect(await ctx.mongo.findOrder(projectId, orderId)).toBeNull();
      expect(await ctx.mongo.countByProject('crm_orders', projectId)).toBe(0);
    });
  });
});
