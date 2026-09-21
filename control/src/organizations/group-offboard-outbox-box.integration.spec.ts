import {
  BoxGatewayClient,
  BoxPostgresHelper,
  createBoxGatewayClient,
  createOffboardTestProject,
  deactivateMember,
  describeBoxIntegration,
  LocalControlHarness,
  requestProjectPurge,
  setupOffboardFixture,
  startLocalControlApp,
  teardownOffboardProject,
  resolveBoxActorUserId,
} from '@fairflow/testing';

jest.setTimeout(300_000);

/**
 * Control-side outbox contract for catalog #45–#50.
 * Asserts `control.member.offboarded` / `control.project.purged` envelopes are
 * published with valid payloads (deactivateMember / requestProjectPurge helpers).
 * Peer consumption is covered separately in group-offboard-* behavioral specs.
 */
describeBoxIntegration('group-offboard outbox contract (control local, the box stand stores)', () => {
  let harness: LocalControlHarness;
  let gateway: BoxGatewayClient;
  let postgres: BoxPostgresHelper;
  let actorUserId: string;

  beforeAll(async () => {
    harness = await startLocalControlApp();
    actorUserId = await resolveBoxActorUserId();
    gateway = await createBoxGatewayClient();
    postgres = await BoxPostgresHelper.connect();
  });

  afterAll(async () => {
    await harness?.stop();
    await postgres?.close();
  });

  it('#45: member offboarded publishes control.member.offboarded for orders peer', async () => {
    const { projectId, employee } = await setupOffboardFixture(harness, gateway, 'outbox-orders', [
      'orders',
    ]);
    try {
      await deactivateMember(
        harness,
        employee.userId,
        actorUserId,
        actorUserId,
        projectId,
        postgres,
      );
    } finally {
      await teardownOffboardProject(harness, projectId, actorUserId).catch(() => undefined);
    }
  });

  it('#46: member offboarded publishes control.member.offboarded for contact peer', async () => {
    const { projectId, employee } = await setupOffboardFixture(harness, gateway, 'outbox-contact', [
      'contacts',
    ]);
    try {
      await deactivateMember(
        harness,
        employee.userId,
        actorUserId,
        actorUserId,
        projectId,
        postgres,
      );
    } finally {
      await teardownOffboardProject(harness, projectId, actorUserId).catch(() => undefined);
    }
  });

  it('#47: member offboarded publishes control.member.offboarded for company peer', async () => {
    const { projectId, employee } = await setupOffboardFixture(harness, gateway, 'outbox-company', [
      'companies',
    ]);
    try {
      await deactivateMember(
        harness,
        employee.userId,
        actorUserId,
        actorUserId,
        projectId,
        postgres,
      );
    } finally {
      await teardownOffboardProject(harness, projectId, actorUserId).catch(() => undefined);
    }
  });

  it('#48: member offboarded publishes control.member.offboarded for documents peer', async () => {
    const { projectId, employee } = await setupOffboardFixture(
      harness,
      gateway,
      'outbox-documents',
      ['documents'],
    );
    try {
      await deactivateMember(
        harness,
        employee.userId,
        actorUserId,
        actorUserId,
        projectId,
        postgres,
      );
    } finally {
      await teardownOffboardProject(harness, projectId, actorUserId).catch(() => undefined);
    }
  });

  it('#49: member offboarded publishes control.member.offboarded for activity peer', async () => {
    const { projectId, employee } = await setupOffboardFixture(
      harness,
      gateway,
      'outbox-activity',
      ['activities'],
    );
    try {
      await deactivateMember(
        harness,
        employee.userId,
        actorUserId,
        actorUserId,
        projectId,
        postgres,
      );
    } finally {
      await teardownOffboardProject(harness, projectId, actorUserId).catch(() => undefined);
    }
  });

  it('#50: project purged publishes control.project.purged for all purge peers', async () => {
    const { projectId, projectName } = await createOffboardTestProject(
      harness,
      actorUserId,
      'outbox-purge',
      ['contacts'],
    );
    await requestProjectPurge(harness, postgres, projectId, projectName, actorUserId);
  });
});
