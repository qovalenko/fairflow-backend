import { SearchService } from './search.service';
import { buildMongo, row } from './fake-mongo.testkit';

const PID = 'p1';

describe('SearchService.reindex activities', () => {
  it('indexes live activities from crm_activities', async () => {
    const { mongo, index } = buildMongo({
      activities: [
        row('a1', {
          projectId: PID,
          title: 'Call back',
          status: 'planned',
          type: 'call',
          assigneeId: 'u1',
          deletedAt: null,
        }),
      ],
    });
    const svc = new SearchService(mongo as never);

    const res = await svc.reindex(PID);
    expect(res.indexed_count).toBe(1);
    expect(res.sources).toContain('crm_activities');
    const doc = index.docs.find((d) => d.entityType === 'activity');
    expect(doc?.title).toBe('Call back');
    expect(doc?.path).toBe(`/p/${PID}/activities/a1`);
  });
});
