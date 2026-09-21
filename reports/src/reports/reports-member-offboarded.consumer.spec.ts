import { ReportsMemberOffboardedConsumer } from './reports-member-offboarded.consumer';
import type { ReportsService } from './reports.service';

function make(reassigned = 1) {
  const reassignOrphanedSharedReports = jest.fn().mockResolvedValue({ reassigned });
  const reports = { reassignOrphanedSharedReports } as unknown as ReportsService;
  const rabbit = { consume: jest.fn().mockResolvedValue(undefined) };
  return {
    consumer: new ReportsMemberOffboardedConsumer(reports, rabbit as never),
    reassignOrphanedSharedReports,
  };
}

describe('ReportsMemberOffboardedConsumer', () => {
  it('переназначает shared custom-отчёты ушедшего участника', async () => {
    const { consumer, reassignOrphanedSharedReports } = make(2);
    const out = await consumer.handle({
      projectId: 'p1',
      payload: {
        metadata: { departingUserId: 'leaver', reassignToUserId: 'admin' },
      },
    });
    expect(reassignOrphanedSharedReports).toHaveBeenCalledWith('p1', 'leaver', 'admin');
    expect(out).toBe('reassigned');
  });

  it('dead-letter при отсутствии обязательных полей', async () => {
    const { consumer, reassignOrphanedSharedReports } = make();
    const out = await consumer.handle({ projectId: 'p1', payload: {} });
    expect(reassignOrphanedSharedReports).not.toHaveBeenCalled();
    expect(out).toBe('dead_letter');
  });

  it('skipped когда нет orphaned shared-отчётов', async () => {
    const { consumer, reassignOrphanedSharedReports } = make(0);
    const out = await consumer.handle({
      projectId: 'p1',
      payload: { metadata: { departingUserId: 'u1', reassignToUserId: 'u2' } },
    });
    expect(reassignOrphanedSharedReports).toHaveBeenCalledWith('p1', 'u1', 'u2');
    expect(out).toBe('skipped');
  });

  it('берёт departingUserId из entityId если metadata пуст', async () => {
    const { consumer, reassignOrphanedSharedReports } = make(1);
    await consumer.handle({
      projectId: 'p1',
      payload: { entityId: ' leaver ', metadata: { reassignToUserId: 'admin' } },
    });
    expect(reassignOrphanedSharedReports).toHaveBeenCalledWith('p1', 'leaver', 'admin');
  });

  it('onModuleInit не биндит consumer при MEMBER_OFFBOARD_CONSUMERS_ENABLED=false', async () => {
    const prev = process.env.MEMBER_OFFBOARD_CONSUMERS_ENABLED;
    process.env.MEMBER_OFFBOARD_CONSUMERS_ENABLED = 'false';
    const rabbit = { consume: jest.fn() };
    const local = new ReportsMemberOffboardedConsumer(
      { reassignOrphanedSharedReports: jest.fn() } as never,
      rabbit as never,
    );
    await local.onModuleInit();
    expect(rabbit.consume).not.toHaveBeenCalled();
    if (prev === undefined) delete process.env.MEMBER_OFFBOARD_CONSUMERS_ENABLED;
    else process.env.MEMBER_OFFBOARD_CONSUMERS_ENABLED = prev;
  });

  it('onModuleInit биндит очередь member-offboarded', async () => {
    const prev = process.env.MEMBER_OFFBOARD_CONSUMERS_ENABLED;
    process.env.MEMBER_OFFBOARD_CONSUMERS_ENABLED = 'true';
    const rabbit = { consume: jest.fn().mockResolvedValue(undefined) };
    const local = new ReportsMemberOffboardedConsumer(
      { reassignOrphanedSharedReports: jest.fn() } as never,
      rabbit as never,
    );
    await local.onModuleInit();
    expect(rabbit.consume).toHaveBeenCalledWith(
      expect.stringContaining('reports.member-offboarded'),
      ['control.member.offboarded'],
      expect.any(Function),
    );
    if (prev === undefined) delete process.env.MEMBER_OFFBOARD_CONSUMERS_ENABLED;
    else process.env.MEMBER_OFFBOARD_CONSUMERS_ENABLED = prev;
  });
});
