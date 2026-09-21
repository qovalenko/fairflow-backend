import {
  createOffboardTestProject,
  describeBoxIntegration,
  requestProjectPurge,
  waitForMongoEntityCount,
  waitForProjectCollectionPurged,
  withIsolatedPurgeHarness,
} from '@fairflow/testing';

jest.setTimeout(420_000);

describeBoxIntegration('group-offboard purge contact (control local, peers on the box stand)', () => {
  it.skip('#50: BUG project purged drops contacts for the project', async () => {
    await withIsolatedPurgeHarness(async (ctx) => {
      const { projectId, projectName } = await createOffboardTestProject(
        ctx.harness,
        ctx.actorUserId,
        'purge-contact',
        ['contacts'],
      );
      const contactId = await ctx.gateway.createContact(projectId, {
        first_name: 'Purge',
        last_name: 'Contact',
        email: `purge-contact-${Date.now()}@example.com`,
      });
      await waitForMongoEntityCount(ctx.mongo, 'contacts', projectId);
      const beforeContact = await ctx.mongo.findContact(projectId, contactId);
      expect(beforeContact).toBeTruthy();
      await requestProjectPurge(ctx.harness, ctx.postgres, projectId, projectName, ctx.actorUserId);
      await waitForProjectCollectionPurged(ctx.mongo, 'contacts', projectId);
      expect(await ctx.mongo.findContact(projectId, contactId)).toBeNull();
      expect(await ctx.mongo.countByProject('contacts', projectId)).toBe(0);
    });
  });
});
