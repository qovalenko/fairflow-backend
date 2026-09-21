import { ActivityService } from './activity.service';
import { MongoService } from '../mongo/mongo.service';
import { MongoOutboxStore } from '../outbox/mongo-outbox.store';
import { NameResolverService } from './name-resolver.service';
import { ProjectMembersService } from './project-members.service';

describe('FIELD-ACT-assigneeName', () => {
  function makeHarness() {
    let inserted: Record<string, unknown> | null = null;
    const mongo = {
      activities: () => ({
        insertOne: jest.fn(async (doc: Record<string, unknown>) => {
          inserted = doc;
        }),
        findOne: jest.fn(async () => inserted),
      }),
      getClient: () => ({
        startSession: () => ({
          withTransaction: async (fn: () => Promise<void>) => fn(),
          endSession: async () => undefined,
        }),
      }),
    } as unknown as MongoService;
    const outbox = {
      withOutbox: jest.fn(
        async (work: (s: undefined) => Promise<{ result: unknown; intents: unknown[] }>) => {
          const captured = await work(undefined);
          return captured.result;
        },
      ),
    } as unknown as MongoOutboxStore;
    const projectMembers = {
      assertAssigneeMember: jest.fn().mockResolvedValue(undefined),
      resolveMemberName: jest.fn().mockResolvedValue('Иван Петров'),
    } as unknown as ProjectMembersService;
    const svc = new ActivityService(
      mongo,
      outbox,
      { resolveLinks: jest.fn(async (l: unknown[]) => l) } as unknown as NameResolverService,
      projectMembers,
    );
    return { svc, getInserted: () => inserted, projectMembers };
  }

  it('persists assigneeName on create', async () => {
    const { svc, getInserted, projectMembers } = makeHarness();
    await svc.create({
      project_id: 'p1',
      type: 'task',
      title: 'Звонок',
      assignee_id: 'u1',
    });
    expect(projectMembers.resolveMemberName).toHaveBeenCalledWith('p1', 'u1');
    expect(getInserted()?.assigneeName).toBe('Иван Петров');
  });
});
