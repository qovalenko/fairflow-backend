import { Metadata, status } from '@grpc/grpc-js';
import { GW_METADATA } from '@fairflow/shared';
import { ActivityGrpcController } from './activity.grpc.controller';

describe('ActivityGrpcController', () => {
  const activity = {
    list: jest.fn(),
    listTrash: jest.fn(),
    countOverdue: jest.fn(),
    calendar: jest.fn(),
    get: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
    complete: jest.fn(),
    remove: jest.fn(),
    restore: jest.fn(),
    countOwnedRecords: jest.fn(),
    reassignOwnedRecords: jest.fn(),
    claimReminderFireWithRow: jest.fn(),
    releaseReminderFire: jest.fn(),
  };

  const idempotency = {
    withIdempotency: jest.fn((_p: string, _k: unknown, _op: string, exec: () => unknown) => exec()),
  };

  const controller = new ActivityGrpcController(activity as never, idempotency as never);

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('maps list filters and paging defaults', async () => {
    (activity.list as jest.Mock).mockResolvedValue({ list: [], total: 0 });

    await controller.list({ project_id: 'p-1', page_index: 2, page_size: 10, type: 'task' });

    expect(activity.list).toHaveBeenCalledWith(
      'p-1',
      2,
      10,
      expect.objectContaining({ type: 'task', withoutAssignee: false }),
      undefined,
      { present: false },
    );
  });

  it('passes multiple types via types array', async () => {
    (activity.list as jest.Mock).mockResolvedValue({ list: [], total: 0 });

    await controller.list({ project_id: 'p-1', types: ['task', 'call'] });

    expect(activity.list).toHaveBeenCalledWith(
      'p-1',
      0,
      25,
      expect.objectContaining({ types: ['task', 'call'], type: undefined }),
      undefined,
      { present: false },
    );
  });

  it('forwards listTrash query and visibility metadata', async () => {
    (activity.listTrash as jest.Mock).mockResolvedValue({ list: [], total: 0 });
    const metadata = new Metadata();
    metadata.set(GW_METADATA.PROJECT_ID, 'p-meta');

    await controller.listTrash({ query: 'foo' }, metadata);

    expect(activity.listTrash).toHaveBeenCalledWith('p-meta', 0, 25, 'foo', undefined, {
      present: false,
    });
  });

  it('forwards countOverdue assignee filter', async () => {
    (activity.countOverdue as jest.Mock).mockResolvedValue({ count: 3 });

    await controller.countOverdue({ project_id: 'p-2', assignee_id: 'u-1' });

    expect(activity.countOverdue).toHaveBeenCalledWith('p-2', 'u-1', undefined, { present: false });
  });

  it('maps calendar payload', async () => {
    (activity.calendar as jest.Mock).mockResolvedValue({ list: [] });

    await controller.cal({
      project_id: 'p-3',
      type: 'meeting',
      mine: 'true',
      link_entity_id: 'c-1',
      date_from: 100,
      date_to: 200,
    });

    expect(activity.calendar).toHaveBeenCalledWith(
      'p-3',
      {
        type: 'meeting',
        mine: 'true',
        linkEntityId: 'c-1',
        dateFrom: 100,
        dateTo: 200,
      },
      undefined,
      { present: false },
    );
  });

  it('gets a single activity by id', async () => {
    (activity.get as jest.Mock).mockResolvedValue({ id: 'a-1' });

    await controller.get({ project_id: 'p-4', id: 'a-1' });

    expect(activity.get).toHaveBeenCalledWith('p-4', 'a-1', undefined, { present: false });
  });

  it('create resolves projectId from metadata and assignee from x-user-id', async () => {
    (activity.create as jest.Mock).mockResolvedValue({ id: 'a-new' });
    const metadata = new Metadata();
    metadata.set(GW_METADATA.PROJECT_ID, 'p-trusted');
    metadata.set(GW_METADATA.USER_ID, 'u-creator');

    await controller.create({ title: 'Call' }, metadata);

    expect(activity.create).toHaveBeenCalledWith(
      expect.objectContaining({
        project_id: 'p-trusted',
        projectId: 'p-trusted',
        assignee_id: 'u-creator',
        title: 'Call',
      }),
      undefined,
    );
  });

  it('create wraps mutation in idempotency when key is present', async () => {
    (activity.create as jest.Mock).mockResolvedValue({ id: 'a-idem' });
    const metadata = new Metadata();
    metadata.set(GW_METADATA.PROJECT_ID, 'p-5');
    metadata.set(GW_METADATA.IDEMPOTENCY_KEY, 'idem-create');

    await controller.create({ project_id: 'p-5', title: 'T' }, metadata);

    expect(idempotency.withIdempotency).toHaveBeenCalledWith(
      'p-5',
      'idem-create',
      'create',
      expect.any(Function),
      expect.any(Function),
    );
  });

  it('update forwards can_manage flag', async () => {
    (activity.update as jest.Mock).mockResolvedValue({ id: 'a-1' });

    await controller.update({ project_id: 'p-6', id: 'a-1', title: 'New', can_manage: true });

    expect(activity.update).toHaveBeenCalledWith(
      'p-6',
      'a-1',
      expect.objectContaining({ title: 'New', can_manage: true }),
      undefined,
      true,
      { present: false },
    );
  });

  it('complete uses idempotency namespace', async () => {
    (activity.complete as jest.Mock).mockResolvedValue({ id: 'a-1' });

    await controller.complete({ project_id: 'p-7', id: 'a-1', result: 'done' });

    expect(idempotency.withIdempotency).toHaveBeenCalledWith(
      'p-7',
      '',
      'complete',
      expect.any(Function),
      expect.any(Function),
    );
  });

  it('remove and restore delegate to activity service via idempotency', async () => {
    (activity.remove as jest.Mock).mockResolvedValue({ ok: true });
    (activity.restore as jest.Mock).mockResolvedValue({ id: 'a-1' });

    await controller.remove({ project_id: 'p-8', id: 'a-1', can_manage: true });
    await controller.restore({ project_id: 'p-8', id: 'a-1' });

    expect(activity.remove).toHaveBeenCalledWith('p-8', 'a-1', undefined, true, {
      present: false,
    });
    expect(activity.restore).toHaveBeenCalledWith('p-8', 'a-1', undefined, false, {
      present: false,
    });
  });

  it('countMemberOwnedRecords wraps service count', async () => {
    (activity.countOwnedRecords as jest.Mock).mockResolvedValue(4);

    const result = await controller.countMemberOwnedRecords({
      project_id: 'p-9',
      user_id: 'u-1',
    });

    expect(result).toEqual({ count: 4 });
    expect(activity.countOwnedRecords).toHaveBeenCalledWith('p-9', 'u-1');
  });

  it('reassignMemberOwnedRecords maps reassigned count', async () => {
    (activity.reassignOwnedRecords as jest.Mock).mockResolvedValue({ reassigned: 2 });

    const result = await controller.reassignMemberOwnedRecords({
      project_id: 'p-10',
      from_user_id: 'u-old',
      to_user_id: 'u-new',
    });

    expect(result).toEqual({ reassigned: 2 });
    expect(activity.reassignOwnedRecords).toHaveBeenCalledWith(
      'p-10',
      'u-old',
      'u-new',
      expect.any(Number),
    );
  });

  it('claimReminderFire and releaseReminderFire map row payload', async () => {
    (activity.claimReminderFireWithRow as jest.Mock).mockResolvedValue({
      claimed: true,
      activity: { id: 'a-1' },
    });
    (activity.releaseReminderFire as jest.Mock).mockResolvedValue(undefined);

    await expect(
      controller.claimReminderFire({ project_id: 'p-11', activity_id: 'a-1', fire_at: 123 }),
    ).resolves.toEqual({ claimed: true, activity: { id: 'a-1' } });
    await expect(
      controller.releaseReminderFire({ project_id: 'p-11', activity_id: 'a-1', fire_at: 123 }),
    ).resolves.toEqual({ released: true });

    expect(activity.claimReminderFireWithRow).toHaveBeenCalledWith('p-11', 'a-1', 123);
    expect(activity.releaseReminderFire).toHaveBeenCalledWith('p-11', 'a-1', 123);
  });

  describe('projectId resolution (defense-in-depth)', () => {
    it('rejects conflicting body projectId when metadata is trusted', () => {
      const metadata = new Metadata();
      metadata.set(GW_METADATA.PROJECT_ID, 'p-trusted');
      let thrown: unknown;
      try {
        controller.get({ project_id: 'p-other', id: 'a-1' }, metadata);
      } catch (err) {
        thrown = err;
      }
      expect((thrown as { error?: unknown }).error).toMatchObject({
        code: status.PERMISSION_DENIED,
      });
    });

    it('accepts s2s projectId from body when metadata is absent', async () => {
      (activity.get as jest.Mock).mockResolvedValue({ id: 'a-1' });
      await controller.get({ project_id: 'p-s2s', id: 'a-1' });
      expect(activity.get).toHaveBeenCalledWith('p-s2s', 'a-1', undefined, { present: false });
    });

    it('rejects list when neither metadata nor body provide projectId', () => {
      let thrown: unknown;
      try {
        controller.list({});
      } catch (err) {
        thrown = err;
      }
      expect((thrown as { error?: unknown }).error).toMatchObject({
        code: status.INVALID_ARGUMENT,
      });
      expect(activity.list).not.toHaveBeenCalled();
    });

    it('rejects create when projectId is unresolved even if assignee metadata is present', () => {
      const metadata = new Metadata();
      metadata.set(GW_METADATA.USER_ID, 'u-creator');
      let thrown: unknown;
      try {
        controller.create({ title: 'Call' }, metadata);
      } catch (err) {
        thrown = err;
      }
      expect((thrown as { error?: unknown }).error).toMatchObject({
        code: status.INVALID_ARGUMENT,
      });
      expect(activity.create).not.toHaveBeenCalled();
    });
  });
});
