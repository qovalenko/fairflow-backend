import { ActivityCompletedConsumer } from './activity-completed.consumer';
import type { ContactsService } from './contacts.service';

describe('ActivityCompletedConsumer (FR-CONTACTS-468)', () => {
  const touchLastActivity = jest.fn();
  const consumer = new ActivityCompletedConsumer(
    { touchLastActivity } as unknown as ContactsService,
    { consume: jest.fn() } as never,
  );

  beforeEach(() => {
    touchLastActivity.mockClear();
  });

  it('updates lastActivityAt when contactId and completedAt present', async () => {
    await consumer.handle({
      projectId: 'p1',
      timestamp: 5000,
      payload: { contactId: 'c1', completedAt: 9000 },
    });
    expect(touchLastActivity).toHaveBeenCalledWith('p1', 'c1', 9000);
  });

  it('reads contact from activity links[] (canonical crm.activity.completed payload)', async () => {
    await consumer.handle({
      projectId: 'p1',
      timestamp: 5000,
      payload: {
        completedAt: 9000,
        links: [{ entityType: 'contact', entityId: 'c-from-link' }],
      },
    });
    expect(touchLastActivity).toHaveBeenCalledWith('p1', 'c-from-link', 9000);
  });

  it('skips incomplete payloads', async () => {
    await consumer.handle({ projectId: 'p1', payload: {} });
    expect(touchLastActivity).not.toHaveBeenCalled();
  });
});
