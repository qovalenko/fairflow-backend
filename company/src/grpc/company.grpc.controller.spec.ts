/**
 * gRPC contract surface of the company domain — field mapping, metadata propagation,
 * idempotency wiring. Complements feature specs (attribution, document-variables, ABAC).
 */
import { Metadata } from '@grpc/grpc-js';
import { CompanyGrpcController } from './company.grpc.controller';
import type { CompaniesService } from '../companies/companies.service';
import type { IdempotencyService } from '../idempotency/idempotency.service';
import { ReassignTargetValidator } from '../companies/reassign-target.validator';

const PID = 'proj-1';
const ABSENT_SCOPE = undefined;
const ABSENT_ACCESS = { present: false };
const EMIT_CTX = { userId: 'user-1', causation: undefined };

function metadata(extra: Record<string, string> = {}): Metadata {
  const m = new Metadata();
  m.set('x-project-id', PID);
  m.set('x-user-id', 'user-1');
  for (const [k, v] of Object.entries(extra)) m.set(k, v);
  return m;
}

function sampleRow(over: Record<string, unknown> = {}) {
  return {
    id: 'co1',
    projectId: PID,
    name: 'Акме',
    inn: '7700000000',
    ownerId: 'user-1',
    createdAt: 1,
    updatedAt: 2,
    ...over,
  };
}

function stubCompanies(over: Partial<Record<string, jest.Mock>> = {}) {
  return {
    list: jest.fn().mockResolvedValue({ list: [sampleRow()], total: 1, hiddenByPolicy: 0 }),
    findOne: jest.fn().mockResolvedValue(sampleRow()),
    create: jest.fn().mockResolvedValue(sampleRow({ name: 'New' })),
    update: jest.fn().mockResolvedValue(sampleRow({ name: 'Updated' })),
    updateOwner: jest.fn().mockResolvedValue(sampleRow({ ownerId: 'user-2' })),
    remove: jest.fn().mockResolvedValue(sampleRow({ deletedAt: 3 })),
    purge: jest.fn().mockResolvedValue({ id: 'co1', purged: true }),
    restore: jest.fn().mockResolvedValue(sampleRow({ deletedAt: null })),
    listTrash: jest.fn().mockResolvedValue({ list: [sampleRow()], total: 1 }),
    findDuplicates: jest
      .fn()
      .mockResolvedValue({ candidates: [{ id: 'co2', name: 'Dup', matchReason: 'inn' }] }),
    aggregate: jest.fn().mockResolvedValue({ groups: [{ key: 'u1', count: 2 }] }),
    previewMerge: jest.fn().mockResolvedValue({ fieldConflicts: [{ field: 'name' }] }),
    mergeCompanies: jest
      .fn()
      .mockResolvedValue({ masterId: 'm1', loserId: 'l1', archiveId: 'a1', mergeState: 'pending' }),
    restoreMerge: jest.fn().mockResolvedValue({ loserId: 'l1', masterId: 'm1', restored: true }),
    importCompanies: jest
      .fn()
      .mockResolvedValue({ created: 1, updated: 0, skipped: 0, errors: [] }),
    countOwnedRecords: jest.fn().mockResolvedValue(3),
    reassignOwnedRecords: jest.fn().mockResolvedValue({ reassigned: 2 }),
    resolveDocumentVariables: jest.fn(),
    ...over,
  };
}

function build(companies = stubCompanies(), idempotency?: Partial<IdempotencyService>) {
  const idem = {
    withIdempotency: jest.fn(
      async (_p: string, _k: string | undefined, _op: string, exec: () => Promise<unknown>) =>
        exec(),
    ),
    ...idempotency,
  } as unknown as IdempotencyService;
  const reassignTargets = {
    assertOwnerAssignable: jest.fn().mockResolvedValue(undefined),
    assertDepartmentAssignable: jest.fn().mockResolvedValue(undefined),
  };
  const ctrl = new CompanyGrpcController(
    companies as unknown as CompaniesService,
    idem,
    reassignTargets as unknown as ReassignTargetValidator,
  );
  return { ctrl, companies, idem, reassignTargets };
}

describe('CompanyGrpcController — list/get mapping', () => {
  it('ListCompanies maps snake_case filters and projects proto rows', async () => {
    const companies = stubCompanies();
    const { ctrl } = build(companies);
    const res = await ctrl.list(
      {
        page_index: 1,
        page_size: 10,
        query: 'акме',
        filter_owner_id: 'u1',
        filter_tags: 'vip, key',
        sort_by: 'name',
        sort_dir: 'asc',
      },
      metadata(),
    );
    expect(companies.list).toHaveBeenCalledWith(
      PID,
      expect.objectContaining({
        pageIndex: 1,
        pageSize: 10,
        query: 'акме',
        filterOwnerId: 'u1',
        filterTags: ['vip', 'key'],
        sortBy: 'name',
        sortDir: 'asc',
      }),
      ABSENT_SCOPE,
      ABSENT_ACCESS,
    );
    expect(res.list[0]).toMatchObject({ id: 'co1', project_id: PID, name: 'Акме' });
    expect(res.total).toBe(1);
  });

  it('GetCompany delegates to findOne with project isolation', async () => {
    const companies = stubCompanies();
    const { ctrl } = build(companies);
    const res = await ctrl.get({ id: 'co1' }, metadata());
    expect(companies.findOne).toHaveBeenCalledWith(PID, 'co1', ABSENT_SCOPE, ABSENT_ACCESS);
    expect(res.id).toBe('co1');
  });
});

describe('CompanyGrpcController — mutations', () => {
  it('CreateCompany assigns owner from assignee_id and wraps idempotency', async () => {
    const companies = stubCompanies();
    const { ctrl, idem } = build(companies);
    const md = metadata({ 'idempotency-key': 'create-1' });
    await ctrl.create({ name: 'New', assignee_id: 'user-9' }, md);
    expect(idem.withIdempotency).toHaveBeenCalledWith(
      PID,
      'create-1',
      'create',
      expect.any(Function),
    );
    expect(companies.create).toHaveBeenCalledWith(
      PID,
      expect.objectContaining({ name: 'New', ownerId: 'user-9', createdBy: 'user-1' }),
      EMIT_CTX,
      ABSENT_SCOPE,
      ABSENT_ACCESS,
      { trashCollisionResolution: undefined },
    );
  });

  it('UpdateCompany maps bank fields and updatedBy from metadata', async () => {
    const companies = stubCompanies();
    const { ctrl } = build(companies);
    await ctrl.update({ id: 'co1', name: 'Upd', bank_name: 'Bank', bik: '044525225' }, metadata());
    expect(companies.update).toHaveBeenCalledWith(
      PID,
      'co1',
      expect.objectContaining({
        name: 'Upd',
        bankName: 'Bank',
        bik: '044525225',
        updatedBy: 'user-1',
      }),
      ABSENT_SCOPE,
      ABSENT_ACCESS,
      EMIT_CTX,
    );
  });

  it('UpdateOwner validates assignee targets before mutation', async () => {
    const companies = stubCompanies();
    const { ctrl, reassignTargets } = build(companies);
    await ctrl.updateOwner({ id: 'co1', owner_id: 'user-2', department_id: 'dept-1' }, metadata());
    expect(reassignTargets.assertOwnerAssignable).toHaveBeenCalled();
    expect(reassignTargets.assertDepartmentAssignable).toHaveBeenCalled();
    expect(companies.updateOwner).toHaveBeenCalledWith(
      PID,
      'co1',
      'user-2',
      'dept-1',
      ABSENT_SCOPE,
      ABSENT_ACCESS,
      EMIT_CTX,
    );
  });

  it('DeleteCompany returns proto snapshot from remove()', async () => {
    const companies = stubCompanies();
    const { ctrl } = build(companies);
    const res = await ctrl.del({ id: 'co1' }, metadata());
    expect(companies.remove).toHaveBeenCalled();
    expect(res.deleted_at).toBe(3);
  });

  it('PurgeCompany maps purge result', async () => {
    const { ctrl, companies } = build();
    const res = await ctrl.purge({ id: 'co1' }, metadata());
    expect(companies.purge).toHaveBeenCalled();
    expect(res).toEqual({ id: 'co1', purged: true });
  });

  it('RestoreCompany passes strategy to service', async () => {
    const { ctrl, companies } = build();
    await ctrl.restore({ id: 'co1', strategy: 'force' }, metadata());
    expect(companies.restore).toHaveBeenCalledWith(
      PID,
      'co1',
      'force',
      ABSENT_SCOPE,
      ABSENT_ACCESS,
      EMIT_CTX,
    );
  });
});

describe('CompanyGrpcController — merge/import/ownership RPCs', () => {
  it('FindDuplicates normalizes empty email/website to undefined', async () => {
    const companies = stubCompanies();
    const { ctrl } = build(companies);
    await ctrl.findDuplicates({ inn: '7700', email: '', website: '' }, metadata());
    expect(companies.findDuplicates).toHaveBeenCalledWith(
      PID,
      expect.objectContaining({ inn: '7700', email: undefined, website: undefined }),
      ABSENT_SCOPE,
      ABSENT_ACCESS,
    );
  });

  it('AggregateCompanies forwards group_by', async () => {
    const { ctrl, companies } = build();
    const res = await ctrl.aggregate({ group_by: 'ownerId' }, metadata());
    expect(companies.aggregate).toHaveBeenCalledWith(PID, 'ownerId', ABSENT_SCOPE, ABSENT_ACCESS);
    expect(res.groups).toEqual([{ key: 'u1', count: 2 }]);
  });

  it('PreviewMerge maps field_conflicts', async () => {
    const { ctrl } = build();
    const res = await ctrl.previewMerge({ master_id: 'm1', loser_id: 'l1' }, metadata());
    expect(res.field_conflicts).toEqual([{ field: 'name' }]);
  });

  it('MergeCompanies uses idempotency and maps response fields', async () => {
    const companies = stubCompanies();
    const { ctrl, idem } = build(companies);
    const md = metadata({ 'idempotency-key': 'merge-1' });
    const res = await ctrl.mergeCompanies({ master_id: 'm1', loser_id: 'l1' }, md);
    expect(idem.withIdempotency).toHaveBeenCalledWith(
      PID,
      'merge-1',
      'merge',
      expect.any(Function),
      expect.any(Function),
    );
    expect(res).toEqual({
      master_id: 'm1',
      loser_id: 'l1',
      archive_id: 'a1',
      merge_state: 'pending',
    });
  });

  it('ImportCompanies passes owner from metadata and dedup mode', async () => {
    const companies = stubCompanies();
    const { ctrl, idem } = build(companies);
    const buf = Buffer.from('name\nCo');
    await ctrl.importCompanies(
      { file_content: buf, mapping_json: '{"name":"name"}', dedup_mode: 'skip' },
      metadata({ 'idempotency-key': 'imp-1' }),
    );
    expect(idem.withIdempotency).toHaveBeenCalledWith(PID, 'imp-1', 'import', expect.any(Function));
    expect(companies.importCompanies).toHaveBeenCalledWith(
      PID,
      buf,
      '{"name":"name"}',
      'skip',
      'user-1',
      ABSENT_SCOPE,
      ABSENT_ACCESS,
      EMIT_CTX,
    );
  });

  it('CountMemberOwnedRecords and ReassignMemberOwnedRecords delegate to service', async () => {
    const companies = stubCompanies();
    const { ctrl } = build(companies);
    await expect(ctrl.countMemberOwnedRecords({ user_id: 'u1' }, metadata())).resolves.toEqual({
      count: 3,
    });
    await expect(
      ctrl.reassignMemberOwnedRecords({ from_user_id: 'u1', to_user_id: 'u2' }, metadata()),
    ).resolves.toEqual({ reassigned: 2 });
    expect(companies.countOwnedRecords).toHaveBeenCalledWith(PID, 'u1');
    expect(companies.reassignOwnedRecords).toHaveBeenCalledWith(
      PID,
      'u1',
      'u2',
      expect.any(Number),
    );
  });

  it('ListTrash maps pagination args', async () => {
    const { ctrl, companies } = build();
    await ctrl.listTrash({ page_index: 2, page_size: 5, query: 'x' }, metadata());
    expect(companies.listTrash).toHaveBeenCalledWith(PID, 2, 5, 'x', ABSENT_SCOPE, ABSENT_ACCESS);
  });

  it('RestoreMerge maps revert response', async () => {
    const { ctrl } = build();
    const res = await ctrl.restoreMerge({ archive_id: 'arc1' }, metadata());
    expect(res).toEqual({ loser_id: 'l1', master_id: 'm1', restored: true });
  });
});
