import { ContactMergedListener, CONTACT_MERGED_KEY } from './contact-merged.listener';

describe('ContactMergedListener', () => {
  it('reassigns merged contact ids via DocumentsService', async () => {
    const reassign = jest.fn(async () => ({ groups: 2, versions: 2 }));
    const listener = new ContactMergedListener(
      { consume: jest.fn() } as never,
      { reassignContactDocuments: reassign } as never,
    );
    await listener.handle({
      projectId: 'p1',
      payload: { sourceContactIds: ['c-old'], targetContactId: 'c-new' },
    });
    expect(reassign).toHaveBeenCalledWith('p1', ['c-old'], 'c-new');
  });

  it('exports the bus routing key', () => {
    expect(CONTACT_MERGED_KEY).toBe('crm.contact.merged');
  });

  it('skips reassign when projectId or contact ids are missing', async () => {
    const reassign = jest.fn();
    const listener = new ContactMergedListener(
      { consume: jest.fn() } as never,
      { reassignContactDocuments: reassign } as never,
    );
    await listener.handle({ projectId: '', payload: { sourceContactIds: ['a'], targetContactId: 'b' } });
    await listener.handle({ projectId: 'p1', payload: { sourceContactIds: [], targetContactId: 'b' } });
    expect(reassign).not.toHaveBeenCalled();
  });
});
