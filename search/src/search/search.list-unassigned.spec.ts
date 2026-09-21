import { SearchService } from './search.service';

describe('SearchService.listUnassigned (FR-ORG-530)', () => {
  const find = jest.fn();
  const countDocuments = jest.fn();
  const svc = new SearchService({
    searchIndex: () => ({ find, countDocuments }),
  } as never);

  beforeEach(() => {
    find.mockReset();
    countDocuments.mockReset();
    countDocuments.mockResolvedValue(2);
    const chain = {
      sort: jest.fn().mockReturnThis(),
      limit: jest.fn().mockReturnThis(),
      project: jest.fn().mockReturnThis(),
      toArray: jest.fn().mockResolvedValue([
        {
          entityType: 'contact',
          entityId: 'c1',
          title: 'Иван',
          updatedAt: 1000,
        },
      ]),
    };
    find.mockReturnValue(chain);
  });

  it('filters ownerless rows for a project', async () => {
    const res = await svc.listUnassigned('p1', 'contact', 25);
    expect(countDocuments).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: 'p1',
        ownerId: { $in: [null, ''] },
        entityType: 'contact',
      }),
    );
    expect(res.list[0].entityId).toBe('c1');
    expect(res.total).toBe(2);
  });
});
