/**
 * Непокрытые RPC ContactGrpcController: trash/restore/merge/reassign/metrics/documents.
 */
import { Metadata } from '@grpc/grpc-js';
import { AppError } from '@fairflow/shared';
import { ContactGrpcController } from './contact.grpc.controller';

type Svc = Record<string, jest.Mock>;

function buildController(overrides: Partial<Svc> = {}) {
  const contacts: Svc = {
    list: jest.fn(async () => ({ list: [{ id: 'c1' }], total: 1, hiddenByPolicy: 2 })),
    listTrash: jest.fn(async () => ({ list: [{ id: 't1' }], total: 1 })),
    findOne: jest.fn(async () => ({ id: 'c1', firstName: 'A' })),
    remove: jest.fn(async () => undefined),
    restore: jest.fn(async () => ({ id: 'c1', deletedAt: null })),
    findDuplicates: jest.fn(async () => ({
      candidates: [
        {
          contactId: 'c2',
          displayName: 'B',
          matchedOn: 'email',
          maskedValue: 'a***',
          deleted: false,
        },
      ],
      possibleExternalDuplicate: true,
    })),
    listDuplicateQueue: jest.fn(async () => ({
      pairs: [
        {
          left: { contactId: 'a', displayName: 'A', matchedOn: 'phone', maskedValue: '+7***' },
          right: { contactId: 'b', displayName: 'B', matchedOn: 'phone', maskedValue: '+7***' },
          matchedOn: 'phone',
        },
      ],
      total: 1,
    })),
    merge: jest.fn(async () => ({ id: 'target' })),
    unmerge: jest.fn(async () => ({ id: 'c1' })),
    reassign: jest.fn(async () => ({ reassigned: 3 })),
    reassignFromOwner: jest.fn(async () => ({ reassigned: 5 })),
    getQualityMetrics: jest.fn(async () => ({
      totalContacts: 10,
      filledBothPct: 80,
      duplicateCandidatePairs: 2,
      openDriftLinks: 1,
    })),
    resolveDocumentVariables: jest.fn(async () => ({ variables: { name: 'Ivan' } })),
    countOwnedRecords: jest.fn(async () => 7),
    reassignOwnedRecords: jest.fn(async () => ({ reassigned: 4 })),
    countLiveContacts: jest.fn(async () => 0),
    create: jest.fn(async () => ({ id: 'c1' })),
    ...(overrides as Svc),
  };
  const idempotency = {
    withIdempotency: (_p: string, _k: unknown, _op: string, fn: () => unknown) => fn(),
  };
  const reassignTargets = {
    assertOwnerAssignable: jest.fn(async () => undefined),
    assertDepartmentAssignable: jest.fn(async () => undefined),
  };
  const ctl = new ContactGrpcController(
    contacts as never,
    idempotency as never,
    reassignTargets as never,
  );
  const md = new Metadata();
  md.set('x-project-id', 'p1');
  md.set('x-user-id', 'user-1');
  md.set('x-trace-id', 'trace-abc');
  return { ctl, contacts, md };
}

describe('ListContacts: дополнительные фильтры и clamp page_size', () => {
  it('filter_tags/owner_scope/inactive_days/filter_company_id доезжают до сервиса', async () => {
    const { ctl, contacts, md } = buildController();
    await ctl.listContacts(
      {
        filter_tags: ' vip , hot ',
        owner_scope: 'own',
        inactive_days: 30,
        filter_company_id: 'co-1',
        page_size: 500,
      },
      md,
    );
    expect(contacts.list).toHaveBeenCalledWith(
      'p1',
      0,
      100,
      undefined,
      undefined,
      { present: false },
      false,
      expect.objectContaining({
        filterTags: ['vip', 'hot'],
        ownerScope: 'own',
        inactiveDays: 30,
        companyId: 'co-1',
      }),
    );
  });

  it('hidden_by_policy прокидывается в ответ', async () => {
    const { ctl, md } = buildController();
    const res = await ctl.listContacts({}, md);
    expect(res).toMatchObject({ hidden_by_policy: 2, total: 1 });
  });
});

describe('ListTrash / Delete / Restore', () => {
  it('ListTrash возвращает proto-контакты', async () => {
    const { ctl, contacts, md } = buildController();
    const res = await ctl.listTrash({ page_index: 1, page_size: 10 }, md);
    expect(contacts.listTrash).toHaveBeenCalledWith('p1', 1, 10, undefined, undefined, {
      present: false,
    });
    expect(res.list[0]).toMatchObject({ id: 't1' });
  });

  it('DeleteContact помечает deleted_at в ответе', async () => {
    const { ctl, contacts, md } = buildController();
    const res = (await ctl.deleteContact({ id: 'c1' }, md)) as { deleted_at: number };
    expect(contacts.remove).toHaveBeenCalled();
    expect(res.deleted_at).toBeGreaterThan(0);
  });

  it('RestoreContact передаёт strategy в сервис', async () => {
    const { ctl, contacts, md } = buildController();
    await ctl.restoreContact({ id: 'c1', strategy: 'keep_target' }, md);
    expect(contacts.restore).toHaveBeenCalledWith(
      'p1',
      'c1',
      'keep_target',
      undefined,
      expect.objectContaining({ userId: 'user-1', causation: { traceId: 'trace-abc' } }),
      { present: false },
    );
  });
});

describe('FindDuplicates / ListDuplicateQueue', () => {
  it('FindDuplicates мапит candidates в snake_case', async () => {
    const { ctl, md } = buildController();
    const res = await ctl.findDuplicates({ email: 'a@b.ru' }, md);
    expect(res).toEqual({
      candidates: [
        {
          contact_id: 'c2',
          display_name: 'B',
          matched_on: 'email',
          masked_value: 'a***',
          deleted: false,
        },
      ],
      possible_external_duplicate: true,
    });
  });

  it('ListDuplicateQueue мапит пары дублей', async () => {
    const { ctl, contacts, md } = buildController();
    const res = await ctl.listDuplicateQueue({ page_index: 0, page_size: 50 }, md);
    expect(contacts.listDuplicateQueue).toHaveBeenCalledWith('p1', 0, 50, undefined, {
      present: false,
    });
    expect(res.pairs[0]).toMatchObject({ matched_on: 'phone' });
    expect(res.total).toBe(1);
  });
});

describe('Merge / Unmerge / Reassign RPC', () => {
  it('MergeContacts вызывает сервис через идемпотентность', async () => {
    const { ctl, contacts, md } = buildController();
    await ctl.mergeContacts({ source_id: 's1', target_id: 't1', survivor_fields: [] }, md);
    expect(contacts.merge).toHaveBeenCalledWith(
      'p1',
      's1',
      't1',
      [],
      undefined,
      expect.objectContaining({ userId: 'user-1' }),
      { present: false },
    );
  });

  it('UnmergeContact возвращает proto-контакт', async () => {
    const { ctl, md } = buildController();
    const res = await ctl.unmergeContact({ id: 'c1' }, md);
    expect(res).toMatchObject({ id: 'c1' });
  });

  it('ReassignContacts делегирует в сервис', async () => {
    const { ctl, contacts, md } = buildController();
    const res = await ctl.reassignContacts(
      { contact_ids: ['c1', 'c2'], new_owner_id: 'u2', new_department_id: 'd1' },
      md,
    );
    expect(contacts.reassign).toHaveBeenCalledWith(
      'p1',
      ['c1', 'c2'],
      { newOwnerId: 'u2', newDepartmentId: 'd1' },
      undefined,
      expect.objectContaining({ userId: 'user-1' }),
      { present: false },
    );
    expect(res).toEqual({ reassigned: 3 });
  });

  it('ReassignContactsFromOwner делегирует в сервис', async () => {
    const { ctl, contacts, md } = buildController();
    const res = await ctl.reassignContactsFromOwner({ from_owner_id: 'u1', to_owner_id: 'u2' }, md);
    expect(contacts.reassignFromOwner).toHaveBeenCalledWith(
      'p1',
      'u1',
      'u2',
      undefined,
      expect.objectContaining({ userId: 'user-1' }),
      { present: false },
    );
    expect(res).toEqual({ reassigned: 5 });
  });
});

describe('Quality metrics / document variables / offboard RPC', () => {
  it('GetContactQualityMetrics мапит метрики', async () => {
    const { ctl, md } = buildController();
    const res = await ctl.getContactQualityMetrics({}, md);
    expect(res).toEqual({
      total_contacts: 10,
      filled_both_pct: 80,
      duplicate_candidate_pairs: 2,
      open_drift_links: 1,
    });
  });

  it('ResolveDocumentVariables делегирует в сервис', async () => {
    const { ctl, contacts, md } = buildController();
    md.set('x-record-id', 'c1');
    const res = await ctl.resolveDocumentVariables({ record_id: 'c1' }, md);
    expect(contacts.resolveDocumentVariables).toHaveBeenCalledWith('p1', 'c1', undefined);
    expect(res).toEqual({ variables: { name: 'Ivan' } });
  });

  it('CountMemberOwnedRecords возвращает count', async () => {
    const { ctl, md } = buildController();
    const res = await ctl.countMemberOwnedRecords({ user_id: 'u1' }, md);
    expect(res).toEqual({ count: 7 });
  });

  it('ReassignMemberOwnedRecords возвращает reassigned', async () => {
    const { ctl, contacts, md } = buildController();
    const res = await ctl.reassignMemberOwnedRecords({ from_user_id: 'u1', to_user_id: 'u2' }, md);
    expect(contacts.reassignOwnedRecords).toHaveBeenCalledWith(
      'p1',
      'u1',
      'u2',
      expect.any(Number),
    );
    expect(res).toEqual({ reassigned: 4 });
  });
});

describe('ImportContacts: бинарный файл отклоняется до парсинга', () => {
  it('Excel/бинарный файл → AppError invalid', async () => {
    const { ctl, md } = buildController();
    const binary = Buffer.from([0x50, 0x4b, 0x03, 0x04]);
    await expect(ctl.importContacts({ file_content: binary }, md)).rejects.toBeInstanceOf(AppError);
  });
});
