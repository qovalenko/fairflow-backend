import { ObjectId } from 'mongodb';
import { ContactsService } from './contacts.service';
import type { EmitIntent } from '@fairflow/shared';
import type { ProjectModuleSettingsService } from '../control/project-module-settings.service';

const PID = 'proj-1';

function build(
  docs: Record<string, unknown>[],
  settings: Record<string, unknown> = { driftDetectionEnabled: true },
) {
  const coll = {
    find: (filter: Record<string, unknown>) => ({
      project: () => ({
        toArray: async () =>
          docs.filter(
            (d) =>
              d.projectId === filter.projectId &&
              Array.isArray(d.companyIds) &&
              (d.companyIds as string[]).includes(filter.companyIds as string) &&
              d.deletedAt == null,
          ),
      }),
    }),
    updateOne: jest.fn(
      async (_f: Record<string, unknown>, update: { $set: Record<string, unknown> }) => {
        const doc = docs.find((d) => d.projectId === PID);
        if (doc) Object.assign(doc, update.$set);
        return { modifiedCount: 1 };
      },
    ),
  };
  const intents: EmitIntent[] = [];
  const mongo = { contacts: async () => coll };
  const outbox = {
    withOutbox: async (
      fn: (s: unknown) => Promise<{ result: unknown; intents?: EmitIntent[] }>,
    ) => {
      const r = await fn(undefined);
      if (r.intents) intents.push(...r.intents);
      return r.result;
    },
  };
  const moduleSettings = {
    getIntegrationSettings: jest.fn().mockResolvedValue(settings),
  } as unknown as ProjectModuleSettingsService;
  const svc = new ContactsService(
    mongo as never,
    outbox as never,
    undefined,
    undefined,
    moduleSettings,
  );
  return { svc, coll, intents, moduleSettings };
}

describe('ContactsService.markCompanyLinkOrphaned (FR-MCON-17)', () => {
  it('переносит companyId в orphanedCompanyIds и убирает из companyIds', async () => {
    const doc = {
      _id: new ObjectId(),
      projectId: PID,
      companyIds: ['co-1', 'co-2'],
      orphanedCompanyIds: [] as string[],
      deletedAt: null,
    };
    const { svc, coll } = build([doc]);
    await expect(svc.markCompanyLinkOrphaned(PID, 'co-1')).resolves.toBe(1);
    expect(doc.companyIds).toEqual(['co-2']);
    expect(doc.orphanedCompanyIds).toEqual(['co-1']);
    expect(coll.updateOne).toHaveBeenCalledTimes(1);
  });

  it('возвращает 0, когда driftDetection выключен', async () => {
    const { svc, coll } = build(
      [{ _id: new ObjectId(), projectId: PID, companyIds: ['co-1'], deletedAt: null }],
      { driftDetectionEnabled: false },
    );
    await expect(svc.markCompanyLinkOrphaned(PID, 'co-1')).resolves.toBe(0);
    expect(coll.updateOne).not.toHaveBeenCalled();
  });

  it('возвращает 0, когда контактов с компанией нет', async () => {
    const { svc } = build([]);
    await expect(svc.markCompanyLinkOrphaned(PID, 'co-missing')).resolves.toBe(0);
  });
});

describe('ContactsService.rewriteCompanyOnMerge (FR-COMPANIES-140)', () => {
  it('перепривязывает loser→master и эмитит crm.contact.updated', async () => {
    const id = new ObjectId();
    const doc = {
      _id: id,
      projectId: PID,
      companyIds: ['co-loser'],
      companyLinks: [{ companyId: 'co-loser', role: 'primary' }],
      orphanedCompanyIds: [] as string[],
      deletedAt: null,
    };
    const coll = {
      find: (_filter: Record<string, unknown>, _opts?: unknown) => ({
        project: () => ({
          toArray: async () => [doc],
        }),
      }),
      updateOne: jest.fn(
        async (_f: Record<string, unknown>, update: { $set: Record<string, unknown> }) => {
          Object.assign(doc, update.$set);
          return { modifiedCount: 1 };
        },
      ),
    };
    const intents: EmitIntent[] = [];
    const mongo = { contacts: async () => coll };
    const outbox = {
      withOutbox: async (
        fn: (s: unknown) => Promise<{ result: unknown; intents?: EmitIntent[] }>,
      ) => {
        const r = await fn(undefined);
        if (r.intents) intents.push(...r.intents);
        return r.result;
      },
    };
    const svc = new ContactsService(mongo as never, outbox as never);
    const res = await svc.rewriteCompanyOnMerge(PID, 'co-loser', 'co-master', 'merge-key-1');
    expect(res).toEqual({ rewritten: 1 });
    expect(doc.companyIds).toEqual(['co-master']);
    expect(intents).toHaveLength(1);
    expect(intents[0]).toMatchObject({
      type: 'crm.contact.updated',
      idempotencyKey: `contact.company_merged:${id.toString()}:merge-key-1`,
      payload: {
        contactId: id.toString(),
        changes: [expect.objectContaining({ field: 'companyIds' })],
      },
    });
  });

  it('no-op при пустых/одинаковых id', async () => {
    const { svc, intents } = build([
      { _id: new ObjectId(), projectId: PID, companyIds: ['a'], deletedAt: null },
    ]);
    expect(await svc.rewriteCompanyOnMerge('', 'a', 'b', 'k')).toEqual({ rewritten: 0 });
    expect(await svc.rewriteCompanyOnMerge(PID, 'a', 'a', 'k')).toEqual({ rewritten: 0 });
    expect(intents).toHaveLength(0);
  });
});

describe('ContactsService.countLiveContacts (FR-CONTACTS-380)', () => {
  it('считает живые контакты проекта', async () => {
    const countDocuments = jest.fn().mockResolvedValue(17);
    const mongo = { contacts: jest.fn().mockResolvedValue({ countDocuments }) };
    const svc = new ContactsService(mongo as never, {} as never);
    await expect(svc.countLiveContacts(PID)).resolves.toBe(17);
    expect(countDocuments).toHaveBeenCalledWith({ projectId: PID, deletedAt: null });
  });
});
