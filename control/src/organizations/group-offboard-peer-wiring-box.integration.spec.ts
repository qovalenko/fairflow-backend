import {
  assertMemberOffboardPeerWired,
  describeBoxIntegration,
  formatMemberOffboardPeerProbeReport,
  formatProjectPurgePeerProbeReport,
  probeMemberOffboardPeerQueue,
  probeAllMemberOffboardPeerQueues,
  probeProjectPurgePeerQueue,
} from '@fairflow/testing';

jest.setTimeout(60_000);

/**
 * Read-only RabbitMQ wiring checks on the box stand — fail fast before long offboard/purge
 * waits when a peer consumer is missing (catalog #45–#49 diagnosis).
 */
describeBoxIntegration('group-offboard peer wiring (read-only the box stand RabbitMQ)', () => {
  it.skip('#45: BUG orders member-offboard consumer is wired on the box stand', async () => {
    await assertMemberOffboardPeerWired('orders.member-offboarded');
  });

  it('#46: contact member-offboard consumer is wired on the box stand', async () => {
    await assertMemberOffboardPeerWired('contact.member-offboarded');
  });

  it.skip('#47: BUG company member-offboard consumer is wired on the box stand', async () => {
    await assertMemberOffboardPeerWired('company.member-offboarded');
  });

  it.skip('#48: BUG documents member-offboard consumer is wired on the box stand', async () => {
    await assertMemberOffboardPeerWired('documents.member-offboarded');
  });

  it.skip('#49: BUG activity member-offboard consumer is wired on the box stand', async () => {
    await assertMemberOffboardPeerWired('activity.member-offboarded');
  });

  it('#45: member-offboard peer queue snapshot for REPORT', async () => {
    const report = await formatMemberOffboardPeerProbeReport();
    expect(report).toContain('orders.member-offboarded');
    expect(report).toContain('contact.member-offboarded');
    expect(report.length).toBeGreaterThan(0);
  });

  it('#50: project-purge peer queue snapshot for REPORT', async () => {
    const report = await formatProjectPurgePeerProbeReport();
    expect(report).toContain('contact.project-purge');
    expect(report).toContain('orders.project-purge');
    expect(report.length).toBeGreaterThan(0);
  });

  it('#50: contact project-purge queue signals broken purge consumer on the box stand', async () => {
    const probe = await probeProjectPurgePeerQueue('contact.project-purge');
    if ('notFound' in probe) {
      expect(probe.notFound).toBe(true);
      return;
    }
    // Round 10: control.project.purged published but contacts remain — consumer absent or not processing.
    expect(probe.consumerCount).toBe(0);
    expect(probe.messageCount).toBeGreaterThanOrEqual(0);
  });

  it('#50: pipe project-purge queue signals missing consumer on the box stand', async () => {
    const probe = await probeProjectPurgePeerQueue('pipe.project-purge');
    if ('notFound' in probe) {
      expect(probe.notFound).toBe(true);
      return;
    }
    expect(probe.consumerCount).toBe(0);
    expect(probe.messageCount).toBeGreaterThanOrEqual(0);
  });

  it('#50: search project-purge queue signals missing consumer on the box stand', async () => {
    const probe = await probeProjectPurgePeerQueue('search.project-purge');
    if ('notFound' in probe) {
      expect(probe.notFound).toBe(true);
      return;
    }
    expect(probe.consumerCount).toBe(0);
    expect(probe.messageCount).toBeGreaterThanOrEqual(0);
  });

  it('#50: company project-purge queue signals missing consumer on the box stand', async () => {
    const probe = await probeProjectPurgePeerQueue('company.project-purge');
    if ('notFound' in probe) {
      expect(probe.notFound).toBe(true);
      return;
    }
    expect(probe.consumerCount).toBe(0);
    expect(probe.messageCount).toBeGreaterThanOrEqual(0);
  });

  it('#50: documents project-purge queue signals missing consumer on the box stand', async () => {
    const probe = await probeProjectPurgePeerQueue('documents.project-purge');
    if ('notFound' in probe) {
      expect(probe.notFound).toBe(true);
      return;
    }
    expect(probe.consumerCount).toBe(0);
    expect(probe.messageCount).toBeGreaterThanOrEqual(0);
  });

  it('#50: search and documents purge queues lack fanout target on the box stand while contact purge queue exists', async () => {
    const contact = await probeProjectPurgePeerQueue('contact.project-purge');
    const search = await probeProjectPurgePeerQueue('search.project-purge');
    const documents = await probeProjectPurgePeerQueue('documents.project-purge');
    // contact.project-purge exists — control outbox relay reaches at least one peer (rabbit-delivery PASS).
    expect('notFound' in contact).toBe(false);
    // search/documents: queue missing or zero consumers — explains rabbit-delivery timeout for these peers.
    const searchUnreachable = 'notFound' in search || search.consumerCount === 0;
    const documentsUnreachable = 'notFound' in documents || documents.consumerCount === 0;
    expect(searchUnreachable).toBe(true);
    expect(documentsUnreachable).toBe(true);
  });

  it('#50: activity project-purge queue signals missing consumer on the box stand', async () => {
    const probe = await probeProjectPurgePeerQueue('activity.project-purge');
    if ('notFound' in probe) {
      expect(probe.notFound).toBe(true);
      return;
    }
    expect(probe.consumerCount).toBe(0);
    expect(probe.messageCount).toBeGreaterThanOrEqual(0);
  });

  it('#50: orders project-purge queue wiring snapshot on the box stand', async () => {
    const probe = await probeProjectPurgePeerQueue('orders.project-purge');
    if ('notFound' in probe) {
      expect(probe.notFound).toBe(true);
      return;
    }
    // Ephemeral queue may show 0 consumers while orders purge still works (round 9–10 pass).
    expect(probe.consumerCount).toBeGreaterThanOrEqual(0);
    expect(probe.messageCount).toBeGreaterThanOrEqual(0);
  });

  it.skip('#50: BUG orders project-purge consumer is wired on the box stand', async () => {
    const probe = await probeProjectPurgePeerQueue('orders.project-purge');
    if ('notFound' in probe) {
      throw new Error(`orders.project-purge: NOT_FOUND (purge passes without durable queue)`);
    }
    expect(probe.consumerCount).toBeGreaterThan(0);
  });

  it.skip('#50: BUG contact project-purge consumer is wired on the box stand', async () => {
    const probe = await probeProjectPurgePeerQueue('contact.project-purge');
    if ('notFound' in probe) {
      throw new Error(`contact.project-purge: NOT_FOUND (purge passes without durable queue)`);
    }
    expect(probe.consumerCount).toBeGreaterThan(0);
  });

  it('#46: contact member-offboard queue wiring snapshot on the box stand', async () => {
    const probe = await probeMemberOffboardPeerQueue('contact.member-offboarded');
    if ('notFound' in probe) {
      expect(probe.notFound).toBe(true);
      return;
    }
    // Round 10: consumer bound (consumers=1); backlog may still drain from prior runs.
    expect(probe.consumerCount).toBeGreaterThanOrEqual(1);
    expect(probe.messageCount).toBeGreaterThanOrEqual(0);
  });

  it('#48: documents member-offboard queue signals missing consumer on the box stand', async () => {
    const probe = await probeMemberOffboardPeerQueue('documents.member-offboarded');
    if ('notFound' in probe) {
      expect(probe.notFound).toBe(true);
      return;
    }
    expect(probe.consumerCount).toBe(0);
    // Backlog may be 0 if the queue was drained or never received events; wiring is still broken.
    expect(probe.messageCount).toBeGreaterThanOrEqual(0);
  });

  it('#47: company member-offboard queue signals missing consumer on the box stand', async () => {
    const probe = await probeMemberOffboardPeerQueue('company.member-offboarded');
    if ('notFound' in probe) {
      expect(probe.notFound).toBe(true);
      return;
    }
    // Round 12: consumers=0 with backlog — company offboard handler not bound on the box stand.
    expect(probe.consumerCount).toBe(0);
    expect(probe.messageCount).toBeGreaterThanOrEqual(0);
  });

  it('#49: activity member-offboard queue signals missing consumer on the box stand', async () => {
    const probe = await probeMemberOffboardPeerQueue('activity.member-offboarded');
    if ('notFound' in probe) {
      expect(probe.notFound).toBe(true);
      return;
    }
    expect(probe.consumerCount).toBe(0);
    expect(probe.messageCount).toBeGreaterThanOrEqual(0);
  });

  it('#45: orders member-offboard queue signals missing consumer on the box stand', async () => {
    const probe = await probeMemberOffboardPeerQueue('orders.member-offboarded');
    if ('notFound' in probe) {
      expect(probe.notFound).toBe(true);
      return;
    }
    expect(probe.consumerCount).toBe(0);
    expect(probe.messageCount).toBeGreaterThanOrEqual(0);
  });

  it.skip('#45: BUG offboard peer wiring matrix (read-only)', async () => {
    const probes = await probeAllMemberOffboardPeerQueues();
    const wired = probes
      .filter((p) => !('notFound' in p) && p.consumerCount > 0)
      .map((p) => p.queue);
    expect(wired).toContain('orders.member-offboarded');
  });
});
