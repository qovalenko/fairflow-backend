import { SearchDeltaWriterImpl } from './search-delta.writer';
import type { ProjectionDoc } from './search-projection.apply';

describe('SearchDeltaWriterImpl', () => {
  const search = {
    projectUpsert: jest.fn().mockResolvedValue(undefined),
    indexPurge: jest.fn().mockResolvedValue({ ok: true }),
    indexDelete: jest.fn().mockResolvedValue({ ok: true }),
    indexSourceFields: jest.fn().mockResolvedValue({ name: 'Acme' }),
  };
  const writer = new SearchDeltaWriterImpl(search as never);

  beforeEach(() => jest.clearAllMocks());

  it('delegates upsert to SearchService.projectUpsert', async () => {
    const doc: ProjectionDoc = {
      projectId: 'p1',
      entityType: 'contact',
      entityId: 'c1',
      title: 'Ann',
      sourceUpdatedAt: 100,
      version: 100,
    };
    await writer.upsert(doc);
    expect(search.projectUpsert).toHaveBeenCalledWith(doc);
  });

  it('delegates purge to SearchService.indexPurge', async () => {
    await writer.purge('p1', 'company', 'co1', 200);
    expect(search.indexPurge).toHaveBeenCalledWith({
      projectId: 'p1',
      entityType: 'company',
      entityId: 'co1',
      version: 200,
    });
  });

  it('delegates tombstone to SearchService.indexDelete', async () => {
    await writer.tombstone('p1', 'deal', 'd1', 300);
    expect(search.indexDelete).toHaveBeenCalledWith({
      projectId: 'p1',
      entityType: 'deal',
      entityId: 'd1',
      version: 300,
    });
  });

  it('delegates sourceFields to SearchService.indexSourceFields', async () => {
    await expect(writer.sourceFields('p1', 'company', 'co1')).resolves.toEqual({ name: 'Acme' });
    expect(search.indexSourceFields).toHaveBeenCalledWith('p1', 'company', 'co1');
  });
});
