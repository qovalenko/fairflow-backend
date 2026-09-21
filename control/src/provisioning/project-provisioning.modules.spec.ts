import { ProjectProvisioningService } from './project-provisioning.service';

describe('ProjectProvisioningService.provisionFromTemplate', () => {
  function build() {
    const pipeProvision = jest
      .fn()
      .mockReturnValue({ subscribe: (o: { next: () => void }) => o.next() });
    const pipeSeed = jest
      .fn()
      .mockReturnValue({ subscribe: (o: { next: () => void }) => o.next() });
    const ordersProvision = jest
      .fn()
      .mockReturnValue({ subscribe: (o: { next: () => void }) => o.next() });
    const documentsProvision = jest
      .fn()
      .mockReturnValue({ subscribe: (o: { next: () => void }) => o.next() });

    const service = new ProjectProvisioningService(
      { getService: () => ({ provisionDefaults: pipeProvision, seedDemoData: pipeSeed }) } as never,
      { getService: () => ({ provisionDefaults: ordersProvision }) } as never,
      { getService: () => ({ provisionDefaults: documentsProvision }) } as never,
    );
    service.onModuleInit();
    return { service, pipeProvision, pipeSeed, ordersProvision, documentsProvision };
  }

  it('always provisions pipe and skips orders/documents when modules disabled', async () => {
    const { service, pipeProvision, ordersProvision, documentsProvision } = build();

    const ok = await service.provisionFromTemplate('proj-1', 'tpl-1', ['deals']);

    expect(ok).toBe(true);
    expect(pipeProvision).toHaveBeenCalledTimes(1);
    expect(ordersProvision).not.toHaveBeenCalled();
    expect(documentsProvision).not.toHaveBeenCalled();
  });

  it('calls orders and documents when corresponding modules are enabled', async () => {
    const { service, ordersProvision, documentsProvision } = build();

    const ok = await service.provisionFromTemplate('proj-1', 'tpl-2', [
      'deals',
      'orders',
      'documents',
    ]);

    expect(ok).toBe(true);
    expect(ordersProvision).toHaveBeenCalledTimes(1);
    expect(documentsProvision).toHaveBeenCalledTimes(1);
  });

  it('seeds demo data through pipe when ownerId is provided', async () => {
    const { service, pipeSeed } = build();

    await service.provisionFromTemplate('proj-1', 'tpl-1', ['deals'], {
      ownerId: 'owner-1',
      assigneeIds: ['a-1'],
    });

    expect(pipeSeed).toHaveBeenCalledWith(
      expect.objectContaining({
        project_id: 'proj-1',
        owner_id: 'owner-1',
        assignee_ids: ['a-1'],
      }),
      expect.anything(),
    );
  });

  it('returns false when a domain provisioning call fails after retries', async () => {
    jest.useFakeTimers();
    const ordersProvision = jest.fn().mockReturnValue({
      subscribe: (o: { error: (e: Error) => void }) => o.error(new Error('orders down')),
    });
    const pipeProvision = jest
      .fn()
      .mockReturnValue({ subscribe: (o: { next: () => void }) => o.next() });
    const pipeSeed = jest
      .fn()
      .mockReturnValue({ subscribe: (o: { next: () => void }) => o.next() });
    const documentsProvision = jest
      .fn()
      .mockReturnValue({ subscribe: (o: { next: () => void }) => o.next() });
    const service = new ProjectProvisioningService(
      { getService: () => ({ provisionDefaults: pipeProvision, seedDemoData: pipeSeed }) } as never,
      { getService: () => ({ provisionDefaults: ordersProvision }) } as never,
      { getService: () => ({ provisionDefaults: documentsProvision }) } as never,
    );
    service.onModuleInit();

    const promise = service.provisionFromTemplate('proj-1', 'tpl-1', ['deals', 'orders']);
    await jest.runAllTimersAsync();

    await expect(promise).resolves.toBe(false);
    expect(ordersProvision).toHaveBeenCalledTimes(3);
    jest.useRealTimers();
  });
});
