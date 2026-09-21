import { RpcException } from '@nestjs/microservices';
import { ObjectId } from 'mongodb';
import { Document, Packer, Paragraph } from 'docx';
import type { VisibilityScope } from '@fairflow/shared';
import { DocumentsService } from './documents.service';
import { DocxValidator } from './docx-validator';

/**
 * B2 — the ACL owner of a document is its CREATOR, never the owner of the record
 * it documents.
 *
 * Regression: the gateway used to send the donor record's owner as
 * `GenerateDocumentRequest.owner_id`, and the domain wrote it straight into
 * `documentGroups.ownerId` — the very field `resolveGroupVisible` gates reads on.
 * A member with "only own" visibility who generated a document on a deal shared
 * with him produced a document owned by the deal's assignee and got 404 on his
 * own document with the next GET.
 *
 * Mirror regression (the reason the gate is a UNION, not a replacement): moving
 * ownership to the creator, with the read gate looking at `ownerId` ALONE, took
 * the document away from the owner of the record it was generated from — the deal
 * owner U stopped seeing, on the Documents tab of HIS OWN deal, the file member M
 * had generated there. So the gate asks about BOTH subjects.
 *
 * The invariants asserted here:
 *  1. generate/upload store `ownerId = acting user`, whatever the request says;
 *  2. the source-record owner is kept separately as `contextOwner*`;
 *  3. the creator can therefore read the document back under the strictest scope;
 *  4. the source-record owner ALSO reads it back (union gate, single + list path);
 *  5. the union never widens the fail-closed branches (no scope / deferred scope);
 *  6. a service-initiated call (no acting user) still yields an owned document.
 */
async function templateDocxBuffer(text: string): Promise<Buffer> {
  const doc = new Document({ sections: [{ children: [new Paragraph(text)] }] });
  return Packer.toBuffer(doc);
}

describe('DocumentsService document ownership (B2)', () => {
  const templatesCollection = { findOne: jest.fn() } as never as {
    findOne: jest.Mock;
  };
  const templateRevisionsCollection = { findOne: jest.fn() } as never as { findOne: jest.Mock };
  const documentGroupsCollection = {
    insertOne: jest.fn(),
    findOne: jest.fn(),
    find: jest.fn(),
    countDocuments: jest.fn(),
  } as never as {
    insertOne: jest.Mock;
    findOne: jest.Mock;
    find: jest.Mock;
    countDocuments: jest.Mock;
  };
  const documentVersionsCollection = {
    insertOne: jest.fn(),
    find: jest.fn(),
    findOne: jest.fn(),
  } as never as {
    insertOne: jest.Mock;
    find: jest.Mock;
    findOne: jest.Mock;
  };

  const mongo = {
    templates: () => templatesCollection,
    templateRevisions: () => templateRevisionsCollection,
    documentGroups: () => documentGroupsCollection,
    documentVersions: () => documentVersionsCollection,
  } as never;

  const s3 = {
    uploadObject: jest.fn(async () => ({ bucket: 'docs' })),
    getObjectBuffer: jest.fn(),
    bucketName: 'docs',
  } as never as { uploadObject: jest.Mock; getObjectBuffer: jest.Mock; bucketName: string };

  const outbox = {
    withOutbox: jest.fn(async (work: (s: undefined) => Promise<{ result: unknown }>) => {
      const { result } = await work(undefined);
      return result;
    }),
  } as never;

  const service = new DocumentsService(mongo, s3 as never, outbox, new DocxValidator());

  /** Strictest realistic scope: the viewer sees only their own records. */
  const onlyOwn = (selfId: string): VisibilityScope => ({
    mode: 'restricted',
    level: 'only_own',
    selfId,
    ownerIds: [selfId],
    sharedRecordIds: [],
  });

  const templateId = new ObjectId();

  beforeEach(async () => {
    jest.clearAllMocks();
    templatesCollection.findOne.mockResolvedValue({
      _id: templateId,
      projectId: 'p-1',
      name: 'Договор',
      status: 'published',
      currentRevision: 1,
    });
    templateRevisionsCollection.findOne.mockResolvedValue({
      projectId: 'p-1',
      templateId: templateId.toString(),
      version: 1,
      bucket: 'docs',
      objectKey: 'p-1/templates/contract.docx',
    });
    s3.getObjectBuffer.mockResolvedValue(await templateDocxBuffer('X {{deal.amount}}'));
    s3.uploadObject.mockResolvedValue({ bucket: 'docs' });
    documentGroupsCollection.insertOne.mockResolvedValue({});
    documentGroupsCollection.countDocuments.mockResolvedValue(0);
    documentGroupsCollection.find.mockReturnValue({
      sort: () => ({ skip: () => ({ limit: () => ({ toArray: async () => [] }) }) }),
    });
    documentVersionsCollection.insertOne.mockResolvedValue({});
    // No idempotency replay row for the automation path.
    documentVersionsCollection.findOne.mockResolvedValue(null);
  });

  it('generate: the acting user owns the document, the deal assignee is only a context snapshot', async () => {
    await service.generateDocument('p-1', 'u-author', {
      template_id: templateId.toString(),
      context_type: 'deal',
      record_id: 'd-1',
      values_json: '{"deal.amount":"10"}',
      // Snapshot of the source deal: assigned to somebody else, in another dept.
      context_owner_id: 'u-assignee',
      context_owner_department_id: 'dep-9',
    });

    const group = documentGroupsCollection.insertOne.mock.calls[0][0] as Record<string, unknown>;
    expect(group.ownerId).toBe('u-author');
    // The department always describes ownerId — unknown for a human creator.
    expect(group.ownerDepartmentId).toBe('');
    expect(group.contextOwnerId).toBe('u-assignee');
    expect(group.contextOwnerDepartmentId).toBe('dep-9');
  });

  it('generate: the author reads his own document back under only_own visibility', async () => {
    await service.generateDocument('p-1', 'u-author', {
      template_id: templateId.toString(),
      context_type: 'deal',
      record_id: 'd-1',
      values_json: '{"deal.amount":"10"}',
      context_owner_id: 'u-assignee',
      context_owner_department_id: 'dep-9',
    });
    const stored = documentGroupsCollection.insertOne.mock.calls[0][0] as Record<string, unknown>;
    const groupId = (stored._id as ObjectId).toString();

    // Read path replays the row the write path produced.
    documentGroupsCollection.findOne.mockResolvedValue(stored);
    documentVersionsCollection.find.mockReturnValue({
      sort: () => ({ toArray: async () => [] }),
    });

    const res = await service.getDocument('p-1', groupId, onlyOwn('u-author'));
    expect(res.group.group_id).toBe(groupId);
    expect(res.group.owner_id).toBe('u-author');
    expect(res.group.context_owner_id).toBe('u-assignee');
  });

  it('regression guard: a group owned by the deal assignee IS hidden from the author (the old behaviour)', async () => {
    const foreign = {
      _id: new ObjectId(),
      projectId: 'p-1',
      ownerId: 'u-assignee',
      contextOwnerId: 'u-assignee',
    };
    documentGroupsCollection.findOne.mockResolvedValue(foreign);
    await expect(
      service.getDocument('p-1', foreign._id.toString(), onlyOwn('u-author')),
    ).rejects.toBeInstanceOf(RpcException);
  });

  it('mirror regression: the owner of the SOURCE record still reads a document a colleague generated on it', async () => {
    // M has "only own" visibility and generates a document on deal d-1, which is
    // owned by U and merely shared with M. The document is born owned by M.
    await service.generateDocument('p-1', 'u-member', {
      template_id: templateId.toString(),
      context_type: 'deal',
      record_id: 'd-1',
      values_json: '{"deal.amount":"10"}',
      context_owner_id: 'u-deal-owner',
      context_owner_department_id: 'dep-1',
    });
    const stored = documentGroupsCollection.insertOne.mock.calls[0][0] as Record<string, unknown>;
    expect(stored.ownerId).toBe('u-member');
    const groupId = (stored._id as ObjectId).toString();

    documentGroupsCollection.findOne.mockResolvedValue(stored);
    documentVersionsCollection.find.mockReturnValue({
      sort: () => ({ toArray: async () => [] }),
    });

    // U opens the Documents tab of HIS deal: the file must still be there.
    const res = await service.getDocument('p-1', groupId, onlyOwn('u-deal-owner'));
    expect(res.group.group_id).toBe(groupId);
    expect(res.group.owner_id).toBe('u-member');
    expect(res.group.context_owner_id).toBe('u-deal-owner');
  });

  it('list: the push-down asks about BOTH subjects (creator OR source-record owner)', async () => {
    await service.listDocuments(
      'p-1',
      { contextType: 'deal', recordId: 'd-1', pageIndex: 0, pageSize: 20 },
      onlyOwn('u-deal-owner'),
    );
    const filter = documentGroupsCollection.countDocuments.mock.calls[0][0] as {
      $and: Record<string, unknown>[];
    };
    const vis = filter.$and.find((c) => Array.isArray(c.$or)) as { $or: unknown[] };
    expect(vis.$or).toEqual(
      expect.arrayContaining([
        { ownerId: { $in: ['u-deal-owner'] } },
        { contextOwnerId: { $in: ['u-deal-owner'] } },
      ]),
    );
    // …and it is the SAME predicate that fetches the rows — no in-memory filtering.
    expect(documentGroupsCollection.find.mock.calls[0][0]).toEqual(filter);
  });

  it('the union never widens the fail-closed branches: no scope and deferred scope stay deny-all', async () => {
    await service.listDocuments('p-1', { pageIndex: 0, pageSize: 20 }, undefined);
    const noScope = JSON.stringify(documentGroupsCollection.countDocuments.mock.calls[0][0]);
    expect(noScope).toContain('$nor');
    expect(noScope).not.toContain('contextOwnerId');

    const deferred: VisibilityScope = {
      mode: 'restricted',
      level: 'only_own',
      selfId: 'u-deal-owner',
      // [#19] an unhydrated deferred scope carries EMPTY lists — matching them
      // against contextOwnerId would have been a silent org-wide read.
      ownerIds: [],
      sharedRecordIds: [],
      deferred: true,
    };
    await service.listDocuments('p-1', { pageIndex: 0, pageSize: 20 }, deferred);
    const deferredFilter = JSON.stringify(
      documentGroupsCollection.countDocuments.mock.calls[1][0],
    );
    expect(deferredFilter).toContain('$nor');
    expect(deferredFilter).not.toContain('contextOwnerId');

    // Single-record gate agrees with the list gate (write gate = read gate).
    documentGroupsCollection.findOne.mockResolvedValue({
      _id: new ObjectId(),
      projectId: 'p-1',
      ownerId: 'u-member',
      contextOwnerId: 'u-deal-owner',
    });
    await expect(
      service.getDocument('p-1', new ObjectId().toString(), deferred),
    ).rejects.toBeInstanceOf(RpcException);
  });

  it('upload: the uploader owns the document in a record context too', async () => {
    await service.uploadDocument('p-1', 'u-uploader', {
      name: 'Скан',
      context_type: 'company',
      record_id: 'co-1',
      bucket: 'docs',
      object_key: 'p-1/documents/company/co-1/scan.pdf',
      mime_type: 'application/pdf',
      size_bytes: 10,
      context_owner_id: 'u-account-manager',
      context_owner_department_id: 'dep-3',
    });

    const group = documentGroupsCollection.insertOne.mock.calls[0][0] as Record<string, unknown>;
    expect(group.ownerId).toBe('u-uploader');
    expect(group.contextOwnerId).toBe('u-account-manager');
    expect(group.contextOwnerDepartmentId).toBe('dep-3');
  });

  it('service-initiated generation (automation, no x-user-id) falls back to the record owner', async () => {
    await service.generateDocument('p-1', '', {
      template_id: templateId.toString(),
      context_type: 'deal',
      record_id: 'd-1',
      trigger_event_id: 'evt-1',
      values_json: '{"deal.amount":"10"}',
      context_owner_id: 'u-assignee',
      context_owner_department_id: 'dep-9',
    });

    const group = documentGroupsCollection.insertOne.mock.calls[0][0] as Record<string, unknown>;
    // No acting user → the document is not left ownerless.
    expect(group.ownerId).toBe('u-assignee');
    // …and now the department genuinely describes the owner.
    expect(group.ownerDepartmentId).toBe('dep-9');
  });
});
