/**
 * FIELD-ACT-departmentId (W-6): у активности появился второй ключ владения —
 * подразделение. Проверяем весь путь поля, а не только запись:
 *  - видимость: запись без assignee видна членам подразделения-владельца;
 *  - запись: create/update валидируют id через control (fail-closed);
 *  - выдача и события несут departmentId (иначе подписчики его не увидят).
 */
import { ObjectId } from 'mongodb';
import type { EmitIntent, VisibilityScope } from '@fairflow/shared';
import { ActivityService } from './activity.service';
import { MongoService } from '../mongo/mongo.service';
import { MongoOutboxStore } from '../outbox/mongo-outbox.store';
import { NameResolverService } from './name-resolver.service';
import { ProjectMembersService } from './project-members.service';

type Doc = Record<string, unknown>;

function restrictedScope(over: Partial<VisibilityScope> = {}): VisibilityScope {
  return {
    mode: 'restricted',
    level: 'only_own',
    selfId: 'u1',
    ownerIds: ['u1'],
    sharedRecordIds: [],
    ...over,
  } as VisibilityScope;
}

function makeService(opts: { doc?: Doc; members?: Partial<ProjectMembersService> } = {}) {
  let capturedFilter: Doc = {};
  const captured: { insert?: Doc; update?: Doc; intents: EmitIntent[] } = { intents: [] };
  const coll = {
    countDocuments: jest.fn((f: Doc) => {
      capturedFilter = f;
      return Promise.resolve(0);
    }),
    find: jest.fn((f: Doc) => {
      capturedFilter = f;
      return {
        sort: () => ({ skip: () => ({ limit: () => ({ toArray: async () => [] }) }) }),
      };
    }),
    // create/update перечитывают запись после записи — отдаём вставленный документ.
    findOne: jest.fn(async () => opts.doc ?? captured.insert ?? null),
    insertOne: jest.fn(async (d: Doc) => {
      captured.insert = d;
      return { insertedId: d._id };
    }),
    updateOne: jest.fn(async (_f: Doc, u: Doc) => {
      captured.update = (u as { $set?: Doc }).$set ?? {};
      return { modifiedCount: 1 };
    }),
  };
  const mongo = { activities: () => coll } as unknown as MongoService;
  const outbox = {
    withOutbox: async (
      fn: (s?: unknown) => Promise<{ result: unknown; intents: EmitIntent[] }>,
    ) => {
      const { result, intents } = await fn(undefined);
      captured.intents.push(...intents);
      return result;
    },
  } as unknown as MongoOutboxStore;
  const nameResolver = {
    resolveLinks: async (_p: string, l: unknown[]) => l,
  } as NameResolverService;
  const members = {
    assertAssigneeMember: jest.fn(async () => undefined),
    assertDepartmentValid: jest.fn(async () => undefined),
    resolveMemberName: jest.fn(async () => ''),
    ...opts.members,
  } as unknown as ProjectMembersService;
  const svc = new ActivityService(mongo, outbox, nameResolver, members);
  return { svc, coll, members, captured, filter: () => capturedFilter };
}

function flatAnd(f: Doc): Doc[] {
  return Array.isArray(f.$and) ? (f.$and as Doc[]) : [f];
}

describe('activity departmentId: видимость', () => {
  it('список отдаёт ветку «подразделение-владелец без assignee» для члена подразделения', async () => {
    const { svc, filter } = makeService();

    await svc.list('p1', 0, 25, {}, restrictedScope({ viewerDepartmentIds: ['dept-1'] }));

    const or = flatAnd(filter()).find((c) => '$or' in c) as { $or: Doc[] } | undefined;
    expect(or?.$or).toContainEqual({
      $and: [
        { departmentId: { $in: ['dept-1'] } },
        { $or: [{ assigneeId: null }, { assigneeId: '' }, { assigneeId: { $exists: false } }] },
      ],
    });
  });

  it('без подразделений у наблюдателя фильтр прежний (только ownerIds)', async () => {
    const { svc, filter } = makeService();

    await svc.list('p1', 0, 25, {}, restrictedScope());

    expect(flatAnd(filter())).toContainEqual({ assigneeId: { $in: ['u1'] } });
  });

  it('карточка: запись подразделения видна его члену, чужая — 404', async () => {
    const visible = makeService({
      doc: { _id: new ObjectId(), projectId: 'p1', assigneeId: '', departmentId: 'dept-1' },
    });
    await expect(
      visible.svc.get(
        'p1',
        new ObjectId().toString(),
        restrictedScope({ viewerDepartmentIds: ['dept-1'] }),
      ),
    ).resolves.toMatchObject({ department_id: 'dept-1' });

    const hidden = makeService({
      doc: { _id: new ObjectId(), projectId: 'p1', assigneeId: '', departmentId: 'dept-9' },
    });
    await expect(
      hidden.svc.get(
        'p1',
        new ObjectId().toString(),
        restrictedScope({ viewerDepartmentIds: ['dept-1'] }),
      ),
    ).rejects.toMatchObject({ error: { message: 'Not found' } });
  });

  it('фильтр списка по подразделению сужает выдачу поверх видимости', async () => {
    const { svc, filter } = makeService();

    await svc.list('p1', 0, 25, { departmentId: 'dept-2' }, restrictedScope());

    expect(flatAnd(filter())).toContainEqual({ departmentId: 'dept-2' });
  });
});

describe('activity departmentId: запись и события', () => {
  const createPayload = {
    project_id: 'p1',
    type: 'task',
    title: 'Позвонить',
    assignee_id: 'u1',
    department_id: 'dept-1',
  };

  it('create валидирует подразделение и сохраняет его', async () => {
    const { svc, members, captured } = makeService();

    await svc.create({ ...createPayload }, restrictedScope());

    expect(members.assertDepartmentValid).toHaveBeenCalledWith('p1', 'dept-1');
    expect(captured.insert).toMatchObject({ departmentId: 'dept-1' });
  });

  it('create кладёт departmentId в crm.activity.created', async () => {
    const { svc, captured } = makeService();

    await svc.create({ ...createPayload }, restrictedScope());

    const created = captured.intents.find((i) => i.type === 'crm.activity.created');
    expect(created?.payload).toMatchObject({ departmentId: 'dept-1' });
  });

  it('create с несуществующим подразделением падает ДО записи', async () => {
    const { svc, coll } = makeService({
      members: {
        assertDepartmentValid: jest.fn(async () => {
          throw new Error('Указано недопустимое подразделение (departmentId)');
        }),
      } as unknown as Partial<ProjectMembersService>,
    });

    await expect(svc.create({ ...createPayload }, restrictedScope())).rejects.toThrow(
      'Указано недопустимое подразделение',
    );
    expect(coll.insertOne).not.toHaveBeenCalled();
  });

  it('пустое поле на create — «не задано», а не поход в control', async () => {
    const { svc, members, captured } = makeService();

    await svc.create({ ...createPayload, department_id: '  ' }, restrictedScope());

    expect(members.assertDepartmentValid).not.toHaveBeenCalled();
    expect(captured.insert).toMatchObject({ departmentId: '' });
  });

  it('update меняет подразделение, событие несёт новое значение', async () => {
    const id = new ObjectId();
    const { svc, members, captured } = makeService({
      doc: {
        _id: id,
        projectId: 'p1',
        assigneeId: 'u1',
        departmentId: 'dept-1',
        type: 'task',
        title: 'Позвонить',
        status: 'planned',
      },
    });

    await svc.update('p1', id.toString(), { department_id: 'dept-2' }, restrictedScope(), false);

    expect(members.assertDepartmentValid).toHaveBeenCalledWith('p1', 'dept-2');
    expect(captured.update).toMatchObject({ departmentId: 'dept-2' });
    const updated = captured.intents.find((i) => i.type === 'crm.activity.updated');
    expect(updated?.payload).toMatchObject({
      departmentId: 'dept-2',
      changedFields: ['departmentId'],
    });
  });

  it('update пустой строкой снимает подразделение без похода в control', async () => {
    const id = new ObjectId();
    const { svc, members, captured } = makeService({
      doc: {
        _id: id,
        projectId: 'p1',
        assigneeId: 'u1',
        departmentId: 'dept-1',
        type: 'task',
        title: 'Позвонить',
        status: 'planned',
      },
    });

    await svc.update('p1', id.toString(), { department_id: '' }, restrictedScope(), false);

    expect(members.assertDepartmentValid).not.toHaveBeenCalled();
    expect(captured.update).toMatchObject({ departmentId: '' });
  });
});
