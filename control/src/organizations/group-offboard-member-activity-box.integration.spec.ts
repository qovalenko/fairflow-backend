import {
  deactivateMember,
  describeBoxIntegration,
  setupOffboardFixture,
  teardownOffboardProject,
  waitFor,
  withIsolatedPurgeHarness,
} from '@fairflow/testing';

jest.setTimeout(180_000);

describeBoxIntegration('group-offboard member activity (control local, peers on the box stand)', () => {
  it.skip('#49: BUG member offboarded reassigns activity assigneeId to the chosen responsible', async () => {
    await withIsolatedPurgeHarness(async (ctx) => {
      const { projectId, employee } = await setupOffboardFixture(
        ctx.harness,
        ctx.gateway,
        'activity',
        ['activities'],
      );
      try {
        const activityId = await ctx.gateway.createActivity(projectId, {
          title: `act-offboard-${Date.now()}`,
          assigneeId: employee.userId,
        });
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
            const doc = await ctx.mongo.findActivity(projectId, activityId);
            return doc?.assigneeId === ctx.actorUserId ? doc : false;
          },
          { label: 'activity assigneeId after offboard', timeoutMs: 90_000 },
        );
        expect(after?.assigneeId).toBe(ctx.actorUserId);
      } finally {
        await teardownOffboardProject(ctx.harness, projectId, ctx.actorUserId).catch(
          () => undefined,
        );
      }
    });
  });
});
