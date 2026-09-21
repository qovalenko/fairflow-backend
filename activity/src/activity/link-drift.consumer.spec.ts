import { LinkDriftConsumer } from './link-drift.consumer';
import { ActivityService } from './activity.service';
import { RabbitMqConsumer } from '../messaging/rabbitmq.consumer';

describe('LinkDriftConsumer (FR-ACTIVITIES-250)', () => {
  function make() {
    const syncLinksForEntity = jest.fn().mockResolvedValue({ updated: 2 });
    const activity = { syncLinksForEntity } as unknown as ActivityService;
    const rabbit = { consume: jest.fn() } as unknown as RabbitMqConsumer;
    return { consumer: new LinkDriftConsumer(activity, rabbit), syncLinksForEntity };
  }

  it('refreshes snapshots on crm.deal.updated', async () => {
    const { consumer, syncLinksForEntity } = make();
    await expect(
      consumer.handle(
        {
          projectId: 'p1',
          subject: 'deal/d-1',
          payload: { dealId: 'd-1', name: 'Big deal' },
        },
        'crm.deal.updated',
      ),
    ).resolves.toEqual({ updated: 2 });
    expect(syncLinksForEntity).toHaveBeenCalledWith('p1', 'deal', 'd-1', 'refresh');
  });

  it('marks orphaned on crm.contact.deleted', async () => {
    const { consumer, syncLinksForEntity } = make();
    await expect(
      consumer.handle(
        {
          projectId: 'p1',
          subject: 'contact/c-9',
          payload: { contactId: 'c-9' },
        },
        'crm.contact.deleted',
      ),
    ).resolves.toEqual({ updated: 2 });
    expect(syncLinksForEntity).toHaveBeenCalledWith('p1', 'contact', 'c-9', 'orphan');
  });

  it('skips events without projectId', async () => {
    const { consumer, syncLinksForEntity } = make();
    await expect(
      consumer.handle({ projectId: '', payload: { dealId: 'd-1' } }, 'crm.deal.updated'),
    ).resolves.toEqual({ updated: 0 });
    expect(syncLinksForEntity).not.toHaveBeenCalled();
  });
});
