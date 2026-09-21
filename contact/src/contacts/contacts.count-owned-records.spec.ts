import { ContactsService } from './contacts.service';
import { MongoService } from '../mongo/mongo.service';
import { MongoOutboxStore } from '../outbox/mongo-outbox.store';

describe('ContactsService.countOwnedRecords (FR-PROJ-215)', () => {
  it('counts non-deleted contacts owned by the user in the project', async () => {
    const countDocuments = jest.fn().mockResolvedValue(4);
    const mongo = {
      contacts: jest.fn().mockResolvedValue({ countDocuments }),
    } as unknown as MongoService;
    const service = new ContactsService(mongo, {} as MongoOutboxStore);
    const n = await service.countOwnedRecords('proj-1', 'user-1');
    expect(n).toBe(4);
    expect(countDocuments).toHaveBeenCalledWith({
      projectId: 'proj-1',
      ownerId: 'user-1',
      deletedAt: null,
    });
  });

  it('returns 0 when projectId or userId is empty', async () => {
    const mongo = { contacts: jest.fn() } as unknown as MongoService;
    const service = new ContactsService(mongo, {} as MongoOutboxStore);
    expect(await service.countOwnedRecords('', 'u')).toBe(0);
    expect(await service.countOwnedRecords('p', '')).toBe(0);
    expect(mongo.contacts).not.toHaveBeenCalled();
  });
});
