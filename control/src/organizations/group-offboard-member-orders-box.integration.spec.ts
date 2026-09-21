import {
  assertMemberOffboardPeerWired,
  deactivateMember,
  describeBoxIntegration,
  setupOffboardFixture,
  teardownOffboardProject,
  waitFor,
  withIsolatedPurgeHarness,
} from '@fairflow/testing';

jest.setTimeout(180_000);

describeBoxIntegration('group-offboard member orders (control local, peers on the box stand)', () => {
  it.skip('#45: BUG member offboarded reassigns order assigneeId to the chosen responsible', async () => {
    await withIsolatedPurgeHarness(async (ctx) => {
      const { projectId, employee } = await setupOffboardFixture(
        ctx.harness,
        ctx.gateway,
        'orders',
        ['orders'],
      );
      try {
        const orderId = await ctx.gateway.createOrder(projectId, {
          title: 'offboard-order',
          assigneeId: employee.userId,
        });
        const seeded = await ctx.mongo.findOrder(projectId, orderId);
        expect(seeded?.assigneeId).toBe(employee.userId);
        await deactivateMember(
          ctx.harness,
          employee.userId,
          ctx.actorUserId,
          ctx.actorUserId,
          projectId,
          ctx.postgres,
        );
        await assertMemberOffboardPeerWired('orders.member-offboarded');
        const after = await waitFor(
          async () => {
            const doc = await ctx.mongo.findOrder(projectId, orderId);
            return doc?.assigneeId === ctx.actorUserId ? doc : false;
          },
          { label: 'order assigneeId after offboard', timeoutMs: 90_000 },
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
