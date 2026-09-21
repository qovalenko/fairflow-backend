import { ProjectPurgeConsumer } from './project-purge.consumer';

/** Smoke test for the documents project-purge consumer (be-purged-consumers). */
class FakeCollection {
  readonly calls: Record<string, unknown>[] = [];
  async deleteMany(filter: Record<string, unknown>) {
    this.calls.push(filter);
    return { deletedCount: 0 };
  }
}

function makeMongo() {
  const c = {
    templates: new FakeCollection(),
    template_revisions: new FakeCollection(),
    document_groups: new FakeCollection(),
    document_versions: new FakeCollection(),
  };
  const mongo = {
    templates: () => c.templates,
    templateRevisions: () => c.template_revisions,
    documentGroups: () => c.document_groups,
    documentVersions: () => c.document_versions,
  } as never;
  return { mongo, c };
}

const env = (projectId?: string) => ({ projectId, payload: {} }) as Record<string, unknown>;

describe('documents ProjectPurgeConsumer', () => {
  let s3: { deleteProjectPrefix: jest.Mock };

  beforeEach(() => {
    s3 = { deleteProjectPrefix: jest.fn(async () => 3) };
  });

  it('drops templates/revisions/groups/versions filtered by { projectId }', async () => {
    const { mongo, c } = makeMongo();
    const consumer = new ProjectPurgeConsumer(mongo, s3 as never, { consume: jest.fn() } as never);
    expect(await consumer.handle(env('p1'))).toBe('purged');
    for (const coll of Object.values(c)) expect(coll.calls).toEqual([{ projectId: 'p1' }]);
    expect(s3.deleteProjectPrefix).toHaveBeenCalledWith('p1');
  });

  it('poison message → dead_letter, nothing deleted', async () => {
    const { mongo, c } = makeMongo();
    const consumer = new ProjectPurgeConsumer(mongo, s3 as never, { consume: jest.fn() } as never);
    expect(await consumer.handle(env(undefined))).toBe('dead_letter');
    for (const coll of Object.values(c)) expect(coll.calls).toHaveLength(0);
    expect(s3.deleteProjectPrefix).not.toHaveBeenCalled();
  });
});
