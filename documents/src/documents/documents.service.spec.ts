import { RpcException } from '@nestjs/microservices';
import { status } from '@grpc/grpc-js';
import { of } from 'rxjs';
import { ObjectId } from 'mongodb';
import { Document, Packer, Paragraph } from 'docx';
import PizZip from 'pizzip';
import Docxtemplater from 'docxtemplater';
import { DocumentsService } from './documents.service';
import { DocxValidator } from './docx-validator';
import { SEED_TEMPLATES } from './seed-templates';

/** A genuine, safe OOXML/.docx buffer for the upload-sanitizer happy path. */
async function validDocxBuffer(): Promise<Buffer> {
  const doc = new Document({ sections: [{ children: [new Paragraph('hello')] }] });
  return Packer.toBuffer(doc);
}

/**
 * A real DOCX template carrying flat dotted docxtemplater placeholders, used to
 * assert that GenerateDocument actually substitutes the resolved variable map
 * into the rendered output (MDOC-9/10) rather than emitting a stub.
 */
async function templateDocxBuffer(text: string): Promise<Buffer> {
  const doc = new Document({ sections: [{ children: [new Paragraph(text)] }] });
  return Packer.toBuffer(doc);
}

/** Extract the concatenated visible text of a rendered DOCX buffer. */
function docxFullText(buf: Buffer): string {
  const doc = new Docxtemplater(new PizZip(buf), { paragraphLoop: true, linebreaks: true });
  return doc.getFullText();
}

describe('DocumentsService', () => {
  const templatesCollection = {
    insertOne: jest.fn(),
    findOne: jest.fn(),
    findOneAndUpdate: jest.fn(),
    updateOne: jest.fn(),
    deleteOne: jest.fn(),
    find: jest.fn(),
  } as any;

  const templateRevisionsCollection = {
    insertOne: jest.fn(),
    findOne: jest.fn(),
    updateOne: jest.fn(),
    find: jest.fn(),
  } as any;

  const documentGroupsCollection = {
    insertOne: jest.fn(),
    countDocuments: jest.fn(),
    find: jest.fn(),
    findOne: jest.fn(),
    updateOne: jest.fn(),
    aggregate: jest.fn(),
  } as any;

  const documentVersionsCollection = {
    insertOne: jest.fn(),
    countDocuments: jest.fn(),
    find: jest.fn(),
    findOne: jest.fn(),
  } as any;

  const mongo = {
    templates: jest.fn(() => templatesCollection),
    templateRevisions: jest.fn(() => templateRevisionsCollection),
    documentGroups: jest.fn(() => documentGroupsCollection),
    documentVersions: jest.fn(() => documentVersionsCollection),
  } as any;

  const s3 = {
    uploadObject: jest.fn(),
    presignDownload: jest.fn(),
    getObjectBuffer: jest.fn(),
    deleteObject: jest.fn(),
    bucketName: 'docs',
  } as any;

  // Outbox stub: run the business work with no session, ignore the emitted intents.
  const outbox = {
    withOutbox: jest.fn(async (work: (s: undefined) => Promise<{ result: unknown }>) => {
      const { result } = await work(undefined);
      return result;
    }),
    enqueue: jest.fn(),
  } as any;

  const service = new DocumentsService(mongo, s3, outbox, new DocxValidator());

  beforeEach(() => {
    jest.clearAllMocks();
    s3.deleteObject.mockResolvedValue(undefined);
  });

  it('throws INVALID_ARGUMENT for empty project_id', async () => {
    await expect(service.listTemplates('')).rejects.toBeInstanceOf(RpcException);
  });

  it('rejects orderTypeId for non-order context', async () => {
    await expect(
      service.createTemplate('p-1', 'u-1', {
        name: 'Contract',
        context_type: 'contact',
        order_type_id: 'ot-1',
        bucket: 'b',
        object_key: 'p-1/templates/x.docx',
      }),
    ).rejects.toBeInstanceOf(RpcException);
  });

  it('narrows order templates by the record sale type (BX-FLOW-4)', async () => {
    templatesCollection.find.mockReturnValue({
      sort: () => ({ toArray: async () => [] }),
    });
    await service.listTemplates('p-1', 'order', 'o-1', undefined, 'ot-9');
    const filter = templatesCollection.find.mock.calls[0][0];
    expect(filter.contextType).toBe('order');
    // exact-type match OR blank (generic order templates apply to every type)
    expect(filter.orderTypeId).toEqual({ $in: ['ot-9', '', null, undefined] });
  });

  it('does not narrow by sale type without an orderTypeId', async () => {
    templatesCollection.find.mockReturnValue({
      sort: () => ({ toArray: async () => [] }),
    });
    await service.listTemplates('p-1', 'order', 'o-1');
    const filter = templatesCollection.find.mock.calls[0][0];
    expect(filter.orderTypeId).toBeUndefined();
  });

  it('creates a draft template with first revision', async () => {
    templatesCollection.insertOne.mockResolvedValue({ insertedId: new ObjectId() });
    templateRevisionsCollection.insertOne.mockResolvedValue({ insertedId: new ObjectId() });
    // Upload sanitizer (FR-MDOC-9/10): the domain fetches the uploaded file and
    // validates it before persisting the revision — feed it a real, safe DOCX.
    s3.getObjectBuffer.mockResolvedValue(await validDocxBuffer());

    const result = await service.createTemplate('p-1', 'u-1', {
      name: '  Contract ',
      context_type: 'order',
      order_type_id: 'ot-1',
      bucket: 'docs',
      object_key: 'p-1/templates/c.docx',
      declared_variables: ['order.number'],
    });

    expect(result.name).toBe('Contract');
    expect(result.project_id).toBe('p-1');
    expect(result.status).toBe('draft');
    expect(result.draft_revision).toBe(1);
    expect(templateRevisionsCollection.insertOne).toHaveBeenCalled();
  });

  it('auto-detects declared variables from the DOCX, ignoring caller input (G2)', async () => {
    templatesCollection.insertOne.mockResolvedValue({ insertedId: new ObjectId() });
    templateRevisionsCollection.insertOne.mockResolvedValue({ insertedId: new ObjectId() });
    // Real DOCX carrying two placeholders; the caller lies about a third.
    s3.getObjectBuffer.mockResolvedValue(
      await templateDocxBuffer('{{company.inn}} and {{company.name}}'),
    );

    await service.createTemplate('p-1', 'u-1', {
      name: 'Contract',
      context_type: 'company',
      bucket: 'docs',
      object_key: 'p-1/templates/c.docx',
      declared_variables: ['made.up'],
    });

    const revision = templateRevisionsCollection.insertOne.mock.calls[0][0];
    // Persisted keys come from the file (sorted/unique), NOT the caller's list.
    expect(revision.declaredVariables).toEqual(['company.inn', 'company.name']);
  });

  it('presigns the current published revision file for template download (BX-DOCS-4)', async () => {
    const templateId = new ObjectId();
    templatesCollection.findOne.mockResolvedValue({
      _id: templateId,
      projectId: 'p-1',
      name: 'Contract',
      status: 'published',
      currentRevision: 2,
      draftRevision: 3,
    });
    templateRevisionsCollection.findOne.mockResolvedValue({
      projectId: 'p-1',
      templateId: templateId.toString(),
      version: 2,
      bucket: 'docs',
      objectKey: 'p-1/templates/contract.docx',
    });
    s3.presignDownload.mockResolvedValue({ url: 'https://s3/dl', expiresAt: 42 });

    const res = await service.getTemplateDownloadUrl('p-1', templateId.toString(), 0, 600);

    // version 0 → falls back to currentRevision (2), NOT the draft.
    expect(templateRevisionsCollection.findOne).toHaveBeenCalledWith(
      expect.objectContaining({ version: 2 }),
    );
    expect(s3.presignDownload).toHaveBeenCalledWith('docs', 'p-1/templates/contract.docx', 600);
    expect(res).toEqual({ url: 'https://s3/dl', expires_at: 42 });
  });

  it('rejects a template-download objectKey outside the project prefix (SEC-C-1)', async () => {
    const templateId = new ObjectId();
    templatesCollection.findOne.mockResolvedValue({
      _id: templateId,
      projectId: 'p-1',
      currentRevision: 1,
    });
    templateRevisionsCollection.findOne.mockResolvedValue({
      version: 1,
      bucket: 'docs',
      objectKey: 'other-project/templates/x.docx',
    });

    await expect(
      service.getTemplateDownloadUrl('p-1', templateId.toString(), 0, undefined),
    ).rejects.toBeInstanceOf(RpcException);
    expect(s3.presignDownload).not.toHaveBeenCalled();
  });

  it('blocks generation from a non-published template', async () => {
    const templateId = new ObjectId();
    templatesCollection.findOne.mockResolvedValue({
      _id: templateId,
      projectId: 'p-2',
      name: 'Offer',
      status: 'draft',
      currentRevision: 0,
    });

    await expect(
      service.generateDocument('p-2', 'u-1', {
        template_id: templateId.toString(),
        context_type: 'deal',
        record_id: 'deal-1',
        values_json: '{"x":"1"}',
      }),
    ).rejects.toBeInstanceOf(RpcException);
  });

  it('substitutes resolved variables into the rendered DOCX (MDOC-9/10)', async () => {
    const templateId = new ObjectId();
    // Published template → generation allowed; render uses currentRevision file.
    templatesCollection.findOne.mockResolvedValue({
      _id: templateId,
      projectId: 'p-3',
      name: 'Договор',
      status: 'published',
      currentRevision: 2,
    });
    // Revision row points at the S3 template file (under the project prefix).
    templateRevisionsCollection.findOne.mockResolvedValue({
      projectId: 'p-3',
      templateId: templateId.toString(),
      version: 2,
      bucket: 'docs',
      objectKey: 'p-3/templates/contract.docx',
    });
    // The stored template DOCX carries flat dotted placeholders + a service var.
    s3.getObjectBuffer.mockResolvedValue(
      await templateDocxBuffer('Клиент {{contact.name}} ИНН {{company.inn}} дата {{today}}'),
    );
    let uploadedBody: Buffer | undefined;
    s3.uploadObject.mockImplementation(async (_key: string, body: Buffer) => {
      uploadedBody = body;
      return { bucket: 'docs' };
    });
    documentGroupsCollection.insertOne.mockResolvedValue({});
    documentVersionsCollection.insertOne.mockResolvedValue({});

    const result = await service.generateDocument('p-3', 'u-1', {
      template_id: templateId.toString(),
      context_type: 'contact',
      record_id: 'c-1',
      values_json: JSON.stringify({ 'contact.name': 'ООО Ромашка', 'company.inn': '7701234567' }),
    });

    expect(result.version.version).toBe(1);
    expect(result.version.file_hash).toMatch(/^[a-f0-9]{64}$/);
    expect(uploadedBody).toBeInstanceOf(Buffer);
    const rendered = docxFullText(uploadedBody as Buffer);
    // Donor values replaced the placeholders...
    expect(rendered).toContain('Клиент ООО Ромашка ИНН 7701234567');
    // ...and the service {{today}} variable resolved to an ISO date (never blank).
    expect(rendered).toMatch(/дата \d{4}-\d{2}-\d{2}/);
    // The raw placeholder syntax must be gone from the output.
    expect(rendered).not.toContain('{{');
  });

  it('renders missing variables as empty string without crashing (FR-MDOC-7)', async () => {
    const templateId = new ObjectId();
    templatesCollection.findOne.mockResolvedValue({
      _id: templateId,
      projectId: 'p-4',
      name: 'Договор',
      status: 'published',
      currentRevision: 1,
    });
    templateRevisionsCollection.findOne.mockResolvedValue({
      projectId: 'p-4',
      templateId: templateId.toString(),
      version: 1,
      bucket: 'docs',
      objectKey: 'p-4/templates/contract.docx',
    });
    s3.getObjectBuffer.mockResolvedValue(
      await templateDocxBuffer('A {{deal.amount}} B {{order.field.missing}} C'),
    );
    let uploadedBody: Buffer | undefined;
    s3.uploadObject.mockImplementation(async (_key: string, body: Buffer) => {
      uploadedBody = body;
      return { bucket: 'docs' };
    });
    documentGroupsCollection.insertOne.mockResolvedValue({});
    documentVersionsCollection.insertOne.mockResolvedValue({});

    await service.generateDocument('p-4', 'u-1', {
      template_id: templateId.toString(),
      context_type: 'deal',
      record_id: 'd-1',
      values_json: JSON.stringify({ 'deal.amount': '100500' }),
      empty_required: ['order.field.missing'],
    });

    const rendered = docxFullText(uploadedBody as Buffer);
    expect(rendered).toContain('A 100500 B  C');
    expect(rendered).not.toContain('{{');
  });

  it('returns the existing version when the trigger_event_id insert loses the race (E11000, FR-DOCS-140)', async () => {
    const templateId = new ObjectId();
    templatesCollection.findOne.mockResolvedValue({
      _id: templateId,
      projectId: 'p-5',
      name: 'Договор',
      status: 'published',
      currentRevision: 1,
    });
    templateRevisionsCollection.findOne.mockResolvedValue({
      projectId: 'p-5',
      templateId: templateId.toString(),
      version: 1,
      bucket: 'docs',
      objectKey: 'p-5/templates/contract.docx',
    });
    s3.getObjectBuffer.mockResolvedValue(await templateDocxBuffer('X {{deal.amount}}'));
    s3.uploadObject.mockResolvedValue({ bucket: 'docs' });
    const winnerGroupId = new ObjectId();
    const winnerVersion = {
      _id: new ObjectId(),
      projectId: 'p-5',
      documentGroupId: winnerGroupId.toString(),
      contextType: 'deal',
      contextRecordId: 'd-1',
      version: 1,
      templateId: templateId.toString(),
      triggerEventId: 'evt-1',
      generatedVia: 'automation',
    };
    // Pre-insert idempotency probe → nothing yet; post-E11000 re-read → winner.
    documentVersionsCollection.findOne
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(winnerVersion);
    documentGroupsCollection.findOne.mockResolvedValue({
      _id: winnerGroupId,
      projectId: 'p-5',
      contextType: 'deal',
      contextRecordId: 'd-1',
      currentVersion: 1,
    });
    // The concurrent delivery already inserted the same trigger_event_id → the
    // unique partial index rejects our insert with a duplicate-key error.
    outbox.withOutbox.mockRejectedValueOnce(
      Object.assign(new Error('E11000 duplicate key error collection'), { code: 11000 }),
    );

    const result = await service.generateDocument('p-5', 'u-1', {
      template_id: templateId.toString(),
      context_type: 'deal',
      record_id: 'd-1',
      trigger_event_id: 'evt-1',
      values_json: '{"deal.amount":"1"}',
    });

    expect(result.version.version_id).toBe(winnerVersion._id.toString());
    expect(result.version.trigger_event_id).toBe('evt-1');
    expect(result.group?.group_id).toBe(winnerGroupId.toString());
  });

  // ── SEC-C-3: chat attachment download requires conversation membership ─────

  const chatVersionOid = new ObjectId();
  const chatGroupOid = new ObjectId();
  /** Viewer with visibility 'all' (project admin) who is NOT a conversation member. */
  const scopeAll = {
    mode: 'all',
    level: 'all',
    selfId: 'u-b',
    ownerIds: [],
    sharedRecordIds: [],
  } as any;

  function mockChatAttachmentDocs() {
    documentVersionsCollection.findOne.mockResolvedValue({
      _id: chatVersionOid,
      projectId: 'p-9',
      documentGroupId: chatGroupOid.toString(),
      contextType: 'chat',
      contextRecordId: 'conv-1',
      bucket: 'docs',
      objectKey: 'p-9/chat/conv-1/file.bin',
    });
    documentGroupsCollection.findOne.mockResolvedValue({
      _id: chatGroupOid,
      projectId: 'p-9',
      contextType: 'chat',
      contextRecordId: 'conv-1',
      ownerId: 'u-a',
    });
    s3.presignDownload.mockResolvedValue({ url: 'https://signed', expiresAt: 123 });
  }

  function serviceWithChat(isMember: boolean, calls?: unknown[]) {
    const chatClient = {
      getService: () => ({
        isConversationMember: (req: unknown) => {
          calls?.push(req);
          return of({ is_member: isMember });
        },
      }),
    } as any;
    return new DocumentsService(mongo, s3, outbox, new DocxValidator(), chatClient);
  }

  it('denies a chat attachment download to a non-member even with visibility=all (SEC-C-3)', async () => {
    mockChatAttachmentDocs();
    const svc = serviceWithChat(false);

    const err = await svc
      .getDownloadUrl('p-9', chatVersionOid.toString(), 0, scopeAll)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RpcException);
    // Existence is masked: NOT_FOUND, not PERMISSION_DENIED.
    expect(((err as RpcException).getError() as { code: number }).code).toBe(status.NOT_FOUND);
    expect(s3.presignDownload).not.toHaveBeenCalled();
  });

  it('presigns a chat attachment download for a conversation member', async () => {
    mockChatAttachmentDocs();
    const calls: unknown[] = [];
    const svc = serviceWithChat(true, calls);

    const result = await svc.getDownloadUrl('p-9', chatVersionOid.toString(), 0, scopeAll);

    expect(result.url).toBe('https://signed');
    expect(calls).toEqual([{ conversation_id: 'conv-1' }]);
  });

  it('fails closed (UNAVAILABLE) for a chat attachment when the chat client is not configured', async () => {
    mockChatAttachmentDocs();
    // `service` is constructed without a chat client — deny, never presign.
    const err = await service
      .getDownloadUrl('p-9', chatVersionOid.toString(), 0, scopeAll)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RpcException);
    expect(((err as RpcException).getError() as { code: number }).code).toBe(status.UNAVAILABLE);
    expect(s3.presignDownload).not.toHaveBeenCalled();
  });

  it('still presigns non-chat documents without any chat membership check', async () => {
    documentVersionsCollection.findOne.mockResolvedValue({
      _id: chatVersionOid,
      projectId: 'p-9',
      documentGroupId: chatGroupOid.toString(),
      contextType: 'deal',
      contextRecordId: 'd-1',
      bucket: 'docs',
      objectKey: 'p-9/documents/deal/d-1/file.docx',
    });
    documentGroupsCollection.findOne.mockResolvedValue({
      _id: chatGroupOid,
      projectId: 'p-9',
      ownerId: 'u-a',
    });
    s3.presignDownload.mockResolvedValue({ url: 'https://signed', expiresAt: 123 });

    const result = await service.getDownloadUrl('p-9', chatVersionOid.toString(), 0, scopeAll);
    expect(result.url).toBe('https://signed');
  });

  it('excludes chat groups from the project-wide list (M-CHAT-8)', async () => {
    documentGroupsCollection.countDocuments.mockResolvedValue(0);
    documentGroupsCollection.find.mockReturnValue({
      sort: () => ({
        skip: () => ({
          limit: () => ({ toArray: async () => [] }),
        }),
      }),
    });
    documentVersionsCollection.find.mockReturnValue({ toArray: async () => [] });

    await service.listDocuments('p-1', { pageIndex: 0, pageSize: 20 });

    const filter = documentGroupsCollection.find.mock.calls[0][0];
    expect(JSON.stringify(filter)).toContain('chat');
    expect(JSON.stringify(filter)).toContain('$ne');
  });

  it('passes templateId and sourceKind filters to Mongo (FR-DOCS-340/390)', async () => {
    documentGroupsCollection.countDocuments.mockResolvedValue(0);
    documentGroupsCollection.find.mockReturnValue({
      sort: () => ({
        skip: () => ({
          limit: () => ({ toArray: async () => [] }),
        }),
      }),
    });
    documentVersionsCollection.find.mockReturnValue({ toArray: async () => [] });

    await service.listDocuments('p-1', {
      pageIndex: 0,
      pageSize: 20,
      templateId: 'tpl-1',
      sourceKind: 'generated',
      search: 'договор',
    });

    const filter = documentGroupsCollection.find.mock.calls[0][0];
    const json = JSON.stringify(filter);
    expect(json).toContain('tpl-1');
    expect(json).toContain('upload');
    expect(json).toContain('$or');
  });

  it('uses aggregation when emptyVarsOnly is set (FR-DOCS-390)', async () => {
    documentGroupsCollection.aggregate.mockReturnValue({
      toArray: async () => [{ total: [{ n: 0 }], rows: [] }],
    });

    await service.listDocuments('p-1', {
      pageIndex: 0,
      pageSize: 20,
      emptyVarsOnly: true,
    });

    expect(documentGroupsCollection.aggregate).toHaveBeenCalled();
    expect(documentGroupsCollection.find).not.toHaveBeenCalled();
  });

  it('excludes chat groups when contextType is present but invalid (M-CHAT-8)', async () => {
    documentGroupsCollection.countDocuments.mockResolvedValue(0);
    documentGroupsCollection.find.mockReturnValue({
      sort: () => ({
        skip: () => ({
          limit: () => ({ toArray: async () => [] }),
        }),
      }),
    });
    documentVersionsCollection.find.mockReturnValue({ toArray: async () => [] });

    await service.listDocuments('p-1', { contextType: 'bogus', pageIndex: 0, pageSize: 20 });

    const filter = documentGroupsCollection.find.mock.calls[0][0];
    expect(JSON.stringify(filter)).toContain('chat');
    expect(JSON.stringify(filter)).toContain('$ne');
  });

  it('accepts a chat upload at the domain RPC (the chat BFF registers attachments here)', async () => {
    // The generic gateway route rejects contextType=chat BEFORE this RPC; the
    // domain itself must keep accepting it or chat attachments break (M-CHAT-8).
    documentGroupsCollection.insertOne.mockResolvedValue({});
    documentVersionsCollection.insertOne.mockResolvedValue({});
    const result = await service.uploadDocument('p-1', 'u-1', {
      name: 'file.pdf',
      context_type: 'chat',
      record_id: 'conv-1',
      bucket: 'docs',
      object_key: 'p-1/chat/conv-1/x.pdf',
    });
    expect(result.group.context_type).toBe('chat');
    expect(result.version.version).toBe(1);
  });

  it('keeps the owner gate for chat groups outside the download path (no membership check there)', async () => {
    mockChatAttachmentDocs();
    const scopeOwn = {
      mode: 'own',
      level: 'only_own',
      selfId: 'u-member',
      ownerIds: ['u-member'],
      sharedRecordIds: [],
    } as any;
    // getDocument / delete / regenerate have no conversation-membership gate, so
    // a restricted scope must NOT see a chat group it does not own (masked 404).
    const err = await service
      .getDocument('p-9', chatGroupOid.toString(), scopeOwn)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RpcException);
    expect(((err as RpcException).getError() as { code: number }).code).toBe(status.NOT_FOUND);
  });

  it('defaults listTemplates to non-archived when status is omitted', async () => {
    templatesCollection.find.mockReturnValue({
      sort: () => ({ toArray: async () => [] }),
    });
    await service.listTemplates('p-1');
    expect(templatesCollection.find.mock.calls[0][0].status).toEqual({ $ne: 'archived' });
  });

  it('reassigns contact-bound groups and versions on merge', async () => {
    documentGroupsCollection.updateMany = jest
      .fn()
      .mockResolvedValueOnce({ modifiedCount: 1 })
      .mockResolvedValueOnce({ modifiedCount: 0 });
    documentVersionsCollection.updateMany = jest.fn().mockResolvedValue({ modifiedCount: 2 });

    const res = await service.reassignContactDocuments('p-1', ['c-old'], 'c-new');
    expect(res).toEqual({ groups: 1, versions: 2 });
    expect(documentGroupsCollection.updateMany).toHaveBeenCalled();
    expect(documentVersionsCollection.updateMany).toHaveBeenCalled();
  });

  it('presigns a chat attachment for a conversation member under only_own scope', async () => {
    mockChatAttachmentDocs();
    const scopeOwn = {
      mode: 'own',
      level: 'only_own',
      selfId: 'u-member',
      ownerIds: ['u-member'],
      sharedRecordIds: [],
    } as any;
    const svc = serviceWithChat(true);
    const result = await svc.getDownloadUrl('p-9', chatVersionOid.toString(), 0, scopeOwn);
    expect(result.url).toBe('https://signed');
  });

  it('checkDrift returns value-level diff when current_values_json is supplied (FR-DOCS-355)', async () => {
    const groupId = new ObjectId();
    documentGroupsCollection.findOne.mockResolvedValue({
      _id: groupId,
      projectId: 'p-1',
      ownerId: 'u-1',
      contextType: 'deal',
      deletedAt: null,
    });
    documentVersionsCollection.countDocuments.mockResolvedValue(1);
    documentVersionsCollection.findOne.mockResolvedValue({
      sourceHash: 'sha256:old',
      valuesSnapshot: { 'deal.amount': '100', 'deal.name': 'Alpha' },
    });

    const res = await service.checkDrift(
      'p-1',
      groupId.toString(),
      {
        sourceHash: 'sha256:new',
        sourceAvailable: true,
        currentValuesJson: JSON.stringify({ 'deal.amount': '200', 'deal.name': 'Alpha' }),
      },
      scopeAll,
    );

    expect(res.has_drift).toBe(true);
    expect(res.changed_keys).toEqual(['deal.amount']);
    expect(res.changed_values).toEqual([
      { key: 'deal.amount', old_value: '100', new_value: '200' },
    ]);
  });

  it('rejects unknown placeholders extracted from a template DOCX (FR-DOCS-080)', async () => {
    s3.getObjectBuffer.mockResolvedValue(await templateDocxBuffer('{{widget.unknown}}'));
    await expect(
      service.createTemplate('p-1', 'u-1', {
        name: 'Bad',
        context_type: 'deal',
        bucket: 'docs',
        object_key: 'p-1/templates/x.docx',
      }),
    ).rejects.toMatchObject({
      message: expect.stringContaining('Неизвестные переменные'),
    });
  });

  it('accepts dynamic order.field.* placeholders in order-context templates (FR-DOCS-080)', async () => {
    templatesCollection.insertOne.mockResolvedValue({ insertedId: new ObjectId() });
    templateRevisionsCollection.insertOne.mockResolvedValue({ insertedId: new ObjectId() });
    s3.getObjectBuffer.mockResolvedValue(
      await templateDocxBuffer('{{order.number}} {{order.field.total}} {{today.iso}}'),
    );

    await service.createTemplate('p-1', 'u-1', {
      name: 'Order contract',
      context_type: 'order',
      bucket: 'docs',
      object_key: 'p-1/templates/o.docx',
    });

    const revision = templateRevisionsCollection.insertOne.mock.calls[0][0];
    expect(revision.declaredVariables).toEqual([
      'order.field.total',
      'order.number',
      'today.iso',
    ]);
  });

  it('checkDrift ignores injected globals in the value diff (no false drift)', async () => {
    const groupId = new ObjectId();
    documentGroupsCollection.findOne.mockResolvedValue({
      _id: groupId,
      projectId: 'p-1',
      ownerId: 'u-1',
      contextType: 'deal',
      deletedAt: null,
    });
    documentVersionsCollection.countDocuments.mockResolvedValue(1);
    // Snapshot as the generate path persists it: donor values + gateway-injected
    // project.name. The drift check only carries the donor map.
    documentVersionsCollection.findOne.mockResolvedValue({
      sourceHash: 'sha256:same',
      valuesSnapshot: { 'deal.amount': '100', 'project.name': 'Acme' },
    });

    const res = await service.checkDrift(
      'p-1',
      groupId.toString(),
      {
        sourceHash: 'sha256:same',
        sourceAvailable: true,
        currentValuesJson: JSON.stringify({ 'deal.amount': '100' }),
      },
      scopeAll,
    );

    expect(res.has_drift).toBe(false);
    expect(res.changed_keys).toEqual([]);
    expect(res.changed_values).toEqual([]);
  });

  it('checkDrift skips the value diff for legacy versions without valuesSnapshot', async () => {
    const groupId = new ObjectId();
    documentGroupsCollection.findOne.mockResolvedValue({
      _id: groupId,
      projectId: 'p-1',
      ownerId: 'u-1',
      contextType: 'deal',
      deletedAt: null,
    });
    documentVersionsCollection.countDocuments.mockResolvedValue(1);
    documentVersionsCollection.findOne.mockResolvedValue({ sourceHash: 'sha256:same' });

    const res = await service.checkDrift(
      'p-1',
      groupId.toString(),
      {
        sourceHash: 'sha256:same',
        sourceAvailable: true,
        currentValuesJson: JSON.stringify({ 'deal.amount': '100' }),
      },
      scopeAll,
    );

    expect(res.has_drift).toBe(false);
    expect(res.changed_keys).toEqual([]);
  });

  it('FR-DOCS-325: rejects generate when the context donor module is disabled', async () => {
    const templateId = new ObjectId();
    templatesCollection.findOne.mockResolvedValue({
      _id: templateId,
      projectId: 'p-2',
      status: 'published',
      currentRevision: 1,
    });

    await expect(
      service.generateDocument(
        'p-2',
        'u-1',
        {
          template_id: templateId.toString(),
          context_type: 'order',
          record_id: 'o-1',
          values_json: '{}',
        },
        ['documents', 'deals'],
      ),
    ).rejects.toMatchObject({
      error: expect.objectContaining({ code: status.FAILED_PRECONDITION }),
    });
  });

  it('FR-DOCS-162: upload rejects unsupported bytes with UNSUPPORTED_MEDIA_TYPE', async () => {
    s3.getObjectBuffer.mockResolvedValue(Buffer.from('not-a-real-upload'));

    await expect(
      service.uploadDocument('p-1', 'u-1', {
        name: 'bad.bin',
        context_type: 'none',
        bucket: 'docs',
        object_key: 'p-1/uploads/none/x.bin',
        mime_type: 'application/pdf',
        size_bytes: 4,
      }),
    ).rejects.toMatchObject({
      error: expect.objectContaining({
        details: { code: 'UNSUPPORTED_MEDIA_TYPE' },
      }),
    });
  });

  it('FR-DOCS-162: upload stores detected mime/size, not client-supplied values', async () => {
    const pdf = Buffer.from('%PDF-1.4 minimal');
    s3.getObjectBuffer.mockResolvedValue(pdf);
    documentGroupsCollection.insertOne.mockResolvedValue({ insertedId: new ObjectId() });
    documentVersionsCollection.insertOne.mockResolvedValue({ insertedId: new ObjectId() });

    await service.uploadDocument('p-1', 'u-1', {
      name: 'scan.pdf',
      context_type: 'none',
      bucket: 'docs',
      object_key: 'p-1/uploads/none/scan.pdf',
      mime_type: 'image/png',
      size_bytes: 1,
    });

    const version = documentVersionsCollection.insertOne.mock.calls[0][0];
    expect(version.mimeType).toBe('application/pdf');
    expect(version.sizeBytes).toBe(pdf.length);
  });

  it('TODO-112: malformed ABAC predicate blocks upload (fail-closed)', async () => {
    await expect(
      service.uploadDocument(
        'p-1',
        'u-1',
        {
          name: 'x.pdf',
          context_type: 'none',
          bucket: 'docs',
          object_key: 'p-1/uploads/none/x.pdf',
        },
        { present: true, malformed: true },
      ),
    ).rejects.toMatchObject({
      error: expect.objectContaining({ code: status.PERMISSION_DENIED }),
    });
    expect(s3.getObjectBuffer).not.toHaveBeenCalled();
  });

  it('SEC-C-1: rejects foreign bucket even when DOCX validation is off', async () => {
    const prev = process.env.DOCUMENTS_DOCX_VALIDATION;
    process.env.DOCUMENTS_DOCX_VALIDATION = 'off';
    try {
      await expect(
        service.createTemplate('p-1', 'u-1', {
          name: 'Tpl',
          context_type: 'deal',
          bucket: 'evil-bucket',
          object_key: 'p-1/templates/x.docx',
        }),
      ).rejects.toMatchObject({
        error: expect.objectContaining({ code: status.INVALID_ARGUMENT }),
      });
    } finally {
      if (prev === undefined) delete process.env.DOCUMENTS_DOCX_VALIDATION;
      else process.env.DOCUMENTS_DOCX_VALIDATION = prev;
    }
  });

  it('SEC-C-1: rejects template file from a foreign bucket', async () => {
    s3.getObjectBuffer.mockResolvedValue(await validDocxBuffer());

    await expect(
      service.createTemplate('p-1', 'u-1', {
        name: 'Tpl',
        context_type: 'deal',
        bucket: 'evil-bucket',
        object_key: 'p-1/templates/x.docx',
      }),
    ).rejects.toMatchObject({
      error: expect.objectContaining({ code: status.INVALID_ARGUMENT }),
    });
  });

  it('publishTemplate promotes the draft revision and emits outbox intents', async () => {
    const templateId = new ObjectId();
    templatesCollection.findOne
      .mockResolvedValueOnce({
        _id: templateId,
        projectId: 'p-pub',
        draftRevision: 2,
        currentRevision: 0,
        status: 'draft',
      })
      .mockResolvedValueOnce({
        _id: templateId,
        projectId: 'p-pub',
        draftRevision: 0,
        currentRevision: 2,
        status: 'published',
      });
    templateRevisionsCollection.findOne.mockResolvedValue({
      projectId: 'p-pub',
      templateId: templateId.toString(),
      version: 2,
      publishedAt: null,
    });
    templateRevisionsCollection.updateOne.mockResolvedValue({});
    templatesCollection.updateOne.mockResolvedValue({});

    const result = await service.publishTemplate('p-pub', templateId.toString(), 'u-1');

    expect(result.status).toBe('published');
    expect(result.current_revision).toBe(2);
    expect(outbox.withOutbox).toHaveBeenCalled();
  });

  it('publishTemplate rejects templates without a draft revision', async () => {
    const templateId = new ObjectId();
    templatesCollection.findOne.mockResolvedValue({
      _id: templateId,
      projectId: 'p-pub',
      draftRevision: 0,
    });
    await expect(
      service.publishTemplate('p-pub', templateId.toString(), 'u-1'),
    ).rejects.toBeInstanceOf(RpcException);
  });

  it('archiveTemplate marks the template archived via outbox', async () => {
    const templateId = new ObjectId();
    templatesCollection.findOneAndUpdate = jest.fn().mockResolvedValue({
      _id: templateId,
      projectId: 'p-arch',
      status: 'archived',
    });
    const result = await service.archiveTemplate('p-arch', templateId.toString(), 'u-1');
    expect(result.status).toBe('archived');
    expect(outbox.withOutbox).toHaveBeenCalled();
  });

  it('deleteTemplate soft-deletes the pointer', async () => {
    const templateId = new ObjectId();
    templatesCollection.updateOne.mockResolvedValue({ matchedCount: 1 });
    await expect(service.deleteTemplate('p-del', templateId.toString())).resolves.toEqual({ ok: true });
  });

  it('deleteTemplate returns NOT_FOUND when nothing matched', async () => {
    const templateId = new ObjectId();
    templatesCollection.updateOne.mockResolvedValue({ matchedCount: 0 });
    await expect(service.deleteTemplate('p-del', templateId.toString())).rejects.toBeInstanceOf(
      RpcException,
    );
  });

  it('getTemplate resolves a specific revision when version is supplied', async () => {
    const templateId = new ObjectId();
    templatesCollection.findOne.mockResolvedValue({
      _id: templateId,
      projectId: 'p-get',
      name: 'Offer',
      currentRevision: 1,
    });
    templateRevisionsCollection.findOne.mockResolvedValue({
      version: 2,
      objectKey: 'p-get/templates/offer.docx',
    });
    const res = await service.getTemplate('p-get', templateId.toString(), 2);
    expect(res.revision?.version).toBe(2);
  });

  it('listTemplateRevisions returns sorted revisions', async () => {
    const templateId = new ObjectId();
    templatesCollection.findOne.mockResolvedValue({ _id: templateId, projectId: 'p-rev' });
    templateRevisionsCollection.find.mockReturnValue({
      sort: () => ({
        toArray: async () => [{ version: 2 }, { version: 1 }],
      }),
    });
    const res = await service.listTemplateRevisions('p-rev', templateId.toString());
    expect(res.list.map((r) => r.version)).toEqual([2, 1]);
  });

  it('regenerateDocument aborts on expected_version mismatch', async () => {
    const groupId = new ObjectId();
    documentGroupsCollection.findOne.mockResolvedValue({
      _id: groupId,
      projectId: 'p-reg',
      ownerId: 'u-1',
      contextType: 'deal',
      contextRecordId: 'd-1',
      templateId: new ObjectId().toString(),
      currentVersion: 3,
      deletedAt: null,
    });
    await expect(
      service.regenerateDocument(
        'p-reg',
        groupId.toString(),
        'u-1',
        { expected_version: 2 },
        scopeAll,
      ),
    ).rejects.toMatchObject({
      error: expect.objectContaining({ code: status.ABORTED }),
    });
  });

  it('regenerateDocument rejects upload-only groups without a template', async () => {
    const groupId = new ObjectId();
    documentGroupsCollection.findOne.mockResolvedValue({
      _id: groupId,
      projectId: 'p-reg',
      ownerId: 'u-1',
      contextType: 'none',
      contextRecordId: '',
      templateId: '',
      currentVersion: 1,
      deletedAt: null,
    });
    await expect(
      service.regenerateDocument('p-reg', groupId.toString(), 'u-1', {}, scopeAll),
    ).rejects.toBeInstanceOf(RpcException);
  });

  it('deleteDocument soft-deletes a visible group', async () => {
    const groupId = new ObjectId();
    documentGroupsCollection.findOne.mockResolvedValue({
      _id: groupId,
      projectId: 'p-del-doc',
      ownerId: 'u-a',
      contextType: 'deal',
      deletedAt: null,
    });
    documentGroupsCollection.updateOne.mockResolvedValue({});
    await expect(
      service.deleteDocument('p-del-doc', groupId.toString(), 'u-a', scopeAll),
    ).resolves.toEqual({ ok: true });
    expect(outbox.withOutbox).toHaveBeenCalled();
  });

  it('checkDriftBatch validates group_ids size', async () => {
    await expect(service.checkDriftBatch('p1', [], scopeAll)).rejects.toBeInstanceOf(RpcException);
    await expect(
      service.checkDriftBatch('p1', Array.from({ length: 101 }, (_, i) => `id-${i}`), scopeAll),
    ).rejects.toBeInstanceOf(RpcException);
  });

  it('checkDriftBatch returns cached drift flags for visible groups', async () => {
    const groupId = new ObjectId();
    documentGroupsCollection.find.mockReturnValue({
      toArray: async () => [{ _id: groupId, driftStale: true }],
    });
    const res = await service.checkDriftBatch('p1', [groupId.toString()], scopeAll);
    expect(res.items).toEqual([
      {
        group_id: groupId.toString(),
        drift: { has_drift: true, changed_keys: [], source_available: true },
      },
    ]);
  });

  it('provisionDefaults skips seeding when the documents module is disabled', async () => {
    const res = await service.provisionDefaults('p-seed', ['deals']);
    expect(res).toEqual({ created: false, templates_created: 0 });
    expect(templatesCollection.findOne).not.toHaveBeenCalled();
  });

  it('countOwnedRecords returns 0 for blank ids', async () => {
    await expect(service.countOwnedRecords('', 'u1')).resolves.toBe(0);
    await expect(service.countOwnedRecords('p1', '  ')).resolves.toBe(0);
  });

  it('reassignOwnedRecords is a no-op when from and to are the same user', async () => {
    await expect(service.reassignOwnedRecords('p1', 'u1', 'u1', Date.now())).resolves.toEqual({
      reassigned: 0,
    });
    expect(outbox.withOutbox).not.toHaveBeenCalled();
  });

  it('getDocument returns the visible group, versions and cached drift flag', async () => {
    const groupId = new ObjectId();
    const scopeAll = {
      mode: 'all',
      level: 'all',
      selfId: 'u1',
      ownerIds: [],
      sharedRecordIds: [],
    } as never;
    documentGroupsCollection.findOne.mockResolvedValue({
      _id: groupId,
      projectId: 'p1',
      contextType: 'deal',
      contextRecordId: 'd-1',
      ownerId: 'u1',
      driftStale: true,
    });
    documentVersionsCollection.find.mockReturnValue({
      sort: () => ({
        toArray: async () => [
          { _id: new ObjectId(), projectId: 'p1', documentGroupId: groupId.toString(), version: 1 },
        ],
      }),
    });
    const res = await service.getDocument('p1', groupId.toString(), scopeAll);
    expect(res.group.group_id).toBe(groupId.toString());
    expect(res.versions).toHaveLength(1);
    expect(res.drift.has_drift).toBe(true);
  });

  it('listVersions returns sorted versions for a visible group', async () => {
    const groupId = new ObjectId();
    const scopeAll = {
      mode: 'all',
      level: 'all',
      selfId: 'u1',
      ownerIds: [],
      sharedRecordIds: [],
    } as never;
    documentGroupsCollection.findOne.mockResolvedValue({
      _id: groupId,
      projectId: 'p1',
      ownerId: 'u1',
    });
    documentVersionsCollection.find.mockReturnValue({
      sort: () => ({
        toArray: async () => [
          { _id: new ObjectId(), projectId: 'p1', documentGroupId: groupId.toString(), version: 2 },
        ],
      }),
    });
    const res = await service.listVersions('p1', groupId.toString(), scopeAll);
    expect(res.list).toHaveLength(1);
    expect(res.list[0].version).toBe(2);
  });

  it('markDriftForRecord flags every group bound to the changed record', async () => {
    const groupId = new ObjectId();
    documentGroupsCollection.find.mockReturnValue({
      toArray: async () => [
        { _id: groupId, projectId: 'p1', contextType: 'contact', contextRecordId: 'c-1' },
      ],
    });
    documentVersionsCollection.findOne.mockResolvedValue({ sourceHash: 'hash-1' });
    const flagged = await service.markDriftForRecord('p1', 'contact', 'c-1');
    expect(flagged).toBe(1);
    expect(outbox.withOutbox).toHaveBeenCalled();
  });

  it('markDriftForRecord returns 0 for invalid context types', async () => {
    await expect(service.markDriftForRecord('p1', 'bogus', 'c-1')).resolves.toBe(0);
    expect(documentGroupsCollection.find).not.toHaveBeenCalled();
  });

  it('getTemplateDownloadUrl surfaces UNAVAILABLE when presign fails', async () => {
    const templateId = new ObjectId();
    templatesCollection.findOne.mockResolvedValue({
      _id: templateId,
      projectId: 'p1',
      currentRevision: 1,
    });
    templateRevisionsCollection.findOne.mockResolvedValue({
      projectId: 'p1',
      templateId: templateId.toString(),
      version: 1,
      bucket: 'docs',
      objectKey: 'p1/templates/t.docx',
    });
    s3.presignDownload.mockRejectedValue(new Error('s3 down'));
    await expect(
      service.getTemplateDownloadUrl('p1', templateId.toString(), 1),
    ).rejects.toMatchObject({ error: expect.objectContaining({ code: status.UNAVAILABLE }) });
  });

  it('createTemplateRevision inserts a new draft revision from uploaded bytes', async () => {
    const templateId = new ObjectId();
    templatesCollection.findOne
      .mockResolvedValueOnce({
        _id: templateId,
        projectId: 'p1',
        contextType: 'contact',
        currentRevision: 1,
        draftRevision: 0,
      })
      .mockResolvedValueOnce({
        _id: templateId,
        projectId: 'p1',
        contextType: 'contact',
        currentRevision: 1,
        draftRevision: 2,
      });
    s3.getObjectBuffer.mockResolvedValue(await validDocxBuffer());
    templateRevisionsCollection.insertOne.mockResolvedValue({ insertedId: new ObjectId() });
    templatesCollection.updateOne.mockResolvedValue({ modifiedCount: 1 });
    const res = await service.createTemplateRevision('p1', templateId.toString(), 'u1', {
      bucket: 'docs',
      object_key: 'p1/templates/rev2.docx',
    });
    expect(templateRevisionsCollection.insertOne).toHaveBeenCalled();
    expect(res.draft_revision).toBe(2);
  });

  it('SEC-C-1: compensates S3 object when domain write fails after upload', async () => {
    const templateId = new ObjectId();
    templatesCollection.findOne.mockResolvedValue({
      _id: templateId,
      projectId: 'p-comp',
      name: 'Offer',
      status: 'published',
      currentRevision: 1,
    });
    templateRevisionsCollection.findOne.mockResolvedValue({
      projectId: 'p-comp',
      templateId: templateId.toString(),
      version: 1,
      bucket: 'docs',
      objectKey: 'p-comp/templates/offer.docx',
    });
    s3.getObjectBuffer.mockResolvedValue(await templateDocxBuffer('Hello {{contact.name}}'));
    s3.uploadObject.mockResolvedValue({ bucket: 'docs' });
    outbox.withOutbox.mockRejectedValueOnce(new Error('mongo down'));

    await expect(
      service.generateDocument('p-comp', 'u-1', {
        template_id: templateId.toString(),
        context_type: 'contact',
        record_id: 'c-1',
        values_json: '{"contact.name":"X"}',
      }),
    ).rejects.toThrow('mongo down');

    expect(s3.uploadObject).toHaveBeenCalled();
    const uploadedKey = s3.uploadObject.mock.calls[0][0] as string;
    expect(s3.deleteObject).toHaveBeenCalledWith('docs', uploadedKey);
  });

  it('provisionDefaults seeds published templates when the documents module is enabled', async () => {
    s3.uploadObject.mockResolvedValue({ bucket: 'docs' });
    s3.getObjectBuffer.mockResolvedValue(await validDocxBuffer());
    templateRevisionsCollection.findOne.mockResolvedValue({
      projectId: 'p-seed',
      version: 1,
      publishedAt: null,
    });
    templateRevisionsCollection.updateOne.mockResolvedValue({});
    templatesCollection.updateOne.mockResolvedValue({});

    const publishLookups = new Map<string, number>();
    templatesCollection.findOne.mockImplementation(async (query: Record<string, unknown>) => {
      if ('name' in query && query.projectId === 'p-seed') {
        return null;
      }
      if ('_id' in query && query.projectId === 'p-seed') {
        const id = String(query._id);
        const pass = publishLookups.get(id) ?? 0;
        publishLookups.set(id, pass + 1);
        if (pass === 0) {
          return {
            _id: query._id,
            projectId: 'p-seed',
            draftRevision: 1,
            currentRevision: 0,
            status: 'draft',
            name: 'Seed',
            contextType: 'deal',
          };
        }
        return {
          _id: query._id,
          projectId: 'p-seed',
          draftRevision: 0,
          currentRevision: 1,
          status: 'published',
          name: 'Seed',
          contextType: 'deal',
        };
      }
      return null;
    });

    const res = await service.provisionDefaults('p-seed', ['documents']);
    expect(res.created).toBe(true);
    expect(res.templates_created).toBe(SEED_TEMPLATES.length);
    expect(s3.uploadObject).toHaveBeenCalledTimes(SEED_TEMPLATES.length);
  });

  it('createTemplate rejects an invalid contextType', async () => {
    await expect(
      service.createTemplate('p1', 'u1', {
        name: 'Tpl',
        context_type: 'chat',
        bucket: 'docs',
        object_key: 'p1/templates/x.docx',
      }),
    ).rejects.toMatchObject({
      error: expect.objectContaining({ code: status.INVALID_ARGUMENT }),
    });
  });

  it('createTemplate rejects uploads without bucket/objectKey', async () => {
    await expect(
      service.createTemplate('p1', 'u1', {
        name: 'Tpl',
        context_type: 'deal',
      }),
    ).rejects.toMatchObject({
      error: expect.objectContaining({ code: status.INVALID_ARGUMENT }),
    });
  });

  it('createTemplate rejects template files outside the project prefix', async () => {
    await expect(
      service.createTemplate('p1', 'u1', {
        name: 'Tpl',
        context_type: 'deal',
        bucket: 'docs',
        object_key: 'other-project/templates/x.docx',
      }),
    ).rejects.toMatchObject({
      error: expect.objectContaining({
        code: status.INVALID_ARGUMENT,
        details: expect.objectContaining({ code: 'TEMPLATE_INVALID' }),
      }),
    });
  });

  it('createTemplate rejects unreadable template bytes from storage', async () => {
    s3.getObjectBuffer.mockRejectedValue(new Error('s3 down'));
    await expect(
      service.createTemplate('p1', 'u1', {
        name: 'Tpl',
        context_type: 'deal',
        bucket: 'docs',
        object_key: 'p1/templates/x.docx',
      }),
    ).rejects.toMatchObject({
      error: expect.objectContaining({
        code: status.INVALID_ARGUMENT,
        details: expect.objectContaining({ reason: 'corrupt' }),
      }),
    });
  });

  it('listDocuments enriches rows with current-version metadata on the simple path', async () => {
    const groupId = new ObjectId();
    documentGroupsCollection.countDocuments.mockResolvedValue(1);
    documentGroupsCollection.find.mockReturnValue({
      sort: () => ({
        skip: () => ({
          limit: () => ({
            toArray: async () => [
              {
                _id: groupId,
                projectId: 'p-list',
                contextType: 'deal',
                currentVersion: 2,
                ownerId: 'u1',
              },
            ],
          }),
        }),
      }),
    });
    documentVersionsCollection.find.mockReturnValue({
      toArray: async () => [
        {
          documentGroupId: groupId.toString(),
          version: 2,
          emptyRequiredVars: ['deal.amount'],
          mimeType: 'application/pdf',
        },
      ],
    });
    const res = await service.listDocuments(
      'p-list',
      { pageIndex: 0, pageSize: 10 },
      scopeAll,
    );
    expect(res.total).toBe(1);
    expect(res.list[0].empty_required_vars).toEqual(['deal.amount']);
    expect(res.list[0].mime_type).toBe('application/pdf');
  });

  it('masks documents that fail the ABAC read gate as NOT_FOUND', async () => {
    const groupId = new ObjectId();
    documentGroupsCollection.findOne.mockResolvedValue({
      _id: groupId,
      projectId: 'p1',
      ownerId: 'u1',
      contextType: 'deal',
    });
    await expect(
      service.getDocument('p1', groupId.toString(), scopeAll, { present: true, malformed: true }),
    ).rejects.toMatchObject({
      error: expect.objectContaining({ code: status.NOT_FOUND }),
    });
  });

  it('listDocuments filters by fileType via the aggregation path', async () => {
    const groupId = new ObjectId();
    documentGroupsCollection.aggregate.mockReturnValue({
      toArray: async () => [
        {
          total: [{ n: 1 }],
          rows: [
            {
              _id: groupId,
              projectId: 'p-agg',
              contextType: 'deal',
              ownerId: 'u1',
              currentVer: { mimeType: 'application/pdf', emptyRequiredVars: [] },
            },
          ],
        },
      ],
    });
    const res = await service.listDocuments(
      'p-agg',
      { pageIndex: 0, pageSize: 10, fileType: 'PDF' },
      scopeAll,
    );
    expect(res.total).toBe(1);
    expect(res.list).toHaveLength(1);
    expect(documentGroupsCollection.aggregate).toHaveBeenCalled();
  });

  it('generateDocument returns an existing automation version before writing', async () => {
    const templateId = new ObjectId();
    const existingGroupId = new ObjectId();
    templatesCollection.findOne.mockResolvedValue({
      _id: templateId,
      projectId: 'p-idem',
      status: 'published',
      currentRevision: 1,
    });
    documentVersionsCollection.findOne.mockResolvedValue({
      _id: new ObjectId(),
      projectId: 'p-idem',
      documentGroupId: existingGroupId.toString(),
      version: 1,
      triggerEventId: 'evt-pre',
    });
    documentGroupsCollection.findOne.mockResolvedValue({
      _id: existingGroupId,
      projectId: 'p-idem',
      currentVersion: 1,
    });
    const res = await service.generateDocument('p-idem', 'u1', {
      template_id: templateId.toString(),
      context_type: 'deal',
      record_id: 'd-1',
      trigger_event_id: 'evt-pre',
      values_json: '{}',
    });
    expect(res.version.trigger_event_id).toBe('evt-pre');
    expect(outbox.withOutbox).not.toHaveBeenCalled();
  });

  it('generateDocument surfaces ABORTED when duplicate-key is not an idempotency replay', async () => {
    const templateId = new ObjectId();
    templatesCollection.findOne.mockResolvedValue({
      _id: templateId,
      projectId: 'p-dup',
      status: 'published',
      currentRevision: 1,
    });
    templateRevisionsCollection.findOne.mockResolvedValue({
      projectId: 'p-dup',
      templateId: templateId.toString(),
      version: 1,
      bucket: 'docs',
      objectKey: 'p-dup/templates/x.docx',
    });
    s3.getObjectBuffer.mockResolvedValue(await templateDocxBuffer('X'));
    s3.uploadObject.mockResolvedValue({ bucket: 'docs' });
    documentVersionsCollection.findOne.mockResolvedValue(null);
    outbox.withOutbox.mockRejectedValueOnce(
      Object.assign(new Error('E11000 duplicate key error collection'), { code: 11000 }),
    );
    await expect(
      service.generateDocument('p-dup', 'u1', {
        template_id: templateId.toString(),
        context_type: 'deal',
        record_id: 'd-1',
        values_json: '{}',
      }),
    ).rejects.toMatchObject({
      error: expect.objectContaining({ code: status.ABORTED }),
    });
  });

  it('regenerateDocument creates the next version from the current template revision', async () => {
    const groupId = new ObjectId();
    const templateId = new ObjectId();
    documentGroupsCollection.findOne
      .mockResolvedValueOnce({
        _id: groupId,
        projectId: 'p-reg-ok',
        ownerId: 'u1',
        contextType: 'deal',
        contextRecordId: 'd-1',
        templateId: templateId.toString(),
        currentVersion: 1,
        deletedAt: null,
      })
      .mockResolvedValueOnce({
        _id: groupId,
        projectId: 'p-reg-ok',
        currentVersion: 2,
      });
    templatesCollection.findOne.mockResolvedValue({
      _id: templateId,
      currentRevision: 2,
    });
    documentVersionsCollection.findOne.mockResolvedValue({
      templateRevision: 1,
      version: 1,
    });
    templateRevisionsCollection.findOne.mockResolvedValue({
      projectId: 'p-reg-ok',
      templateId: templateId.toString(),
      version: 2,
      bucket: 'docs',
      objectKey: 'p-reg-ok/templates/x.docx',
    });
    s3.getObjectBuffer.mockResolvedValue(await templateDocxBuffer('Hello {{deal.amount}}'));
    s3.uploadObject.mockResolvedValue({ bucket: 'docs' });
    documentGroupsCollection.updateOne.mockResolvedValue({ matchedCount: 1 });
    documentVersionsCollection.insertOne.mockResolvedValue({});
    const res = await service.regenerateDocument(
      'p-reg-ok',
      groupId.toString(),
      'u1',
      { values_json: '{"deal.amount":"42"}' },
      scopeAll,
    );
    expect(res.version.version).toBe(2);
    expect(res.group.current_version).toBe(2);
    expect(outbox.withOutbox).toHaveBeenCalled();
  });

  it('uploadDocument requires recordId for non-none contexts', async () => {
    await expect(
      service.uploadDocument('p1', 'u1', {
        name: 'scan.pdf',
        context_type: 'deal',
        bucket: 'docs',
        object_key: 'p1/uploads/deal/scan.pdf',
      }),
    ).rejects.toMatchObject({
      error: expect.objectContaining({ code: status.INVALID_ARGUMENT }),
    });
  });

  it('uploadDocument rejects a foreign bucket even after object validation would pass', async () => {
    await expect(
      service.uploadDocument('p1', 'u1', {
        name: 'scan.pdf',
        context_type: 'none',
        bucket: 'evil',
        object_key: 'p1/uploads/none/scan.pdf',
      }),
    ).rejects.toMatchObject({
      error: expect.objectContaining({ code: status.INVALID_ARGUMENT }),
    });
  });

  it('getDownloadUrl surfaces UNAVAILABLE when presign fails', async () => {
    const versionId = new ObjectId();
    const groupId = new ObjectId();
    documentVersionsCollection.findOne.mockResolvedValue({
      _id: versionId,
      projectId: 'p-dl',
      documentGroupId: groupId.toString(),
      contextType: 'deal',
      bucket: 'docs',
      objectKey: 'p-dl/documents/deal/d-1/file.docx',
    });
    documentGroupsCollection.findOne.mockResolvedValue({
      _id: groupId,
      projectId: 'p-dl',
      ownerId: 'u1',
    });
    s3.presignDownload.mockRejectedValue(new Error('s3 down'));
    await expect(
      service.getDownloadUrl('p-dl', versionId.toString(), 60, scopeAll),
    ).rejects.toMatchObject({
      error: expect.objectContaining({ code: status.UNAVAILABLE }),
    });
  });

  it('getDownloadUrl surfaces UNAVAILABLE when chat membership transport fails', async () => {
    mockChatAttachmentDocs();
    const chatClient = {
      getService: () => ({
        isConversationMember: () => {
          throw Object.assign(new Error('chat down'), { code: status.UNAVAILABLE });
        },
      }),
    } as never;
    const svc = new DocumentsService(mongo, s3, outbox, new DocxValidator(), chatClient);
    await expect(
      svc.getDownloadUrl('p-9', chatVersionOid.toString(), 0, scopeAll),
    ).rejects.toMatchObject({
      error: expect.objectContaining({ code: status.UNAVAILABLE }),
    });
  });

  it('checkDrift reports source unavailable without comparing versions', async () => {
    const groupId = new ObjectId();
    documentGroupsCollection.findOne.mockResolvedValue({
      _id: groupId,
      projectId: 'p-drift',
      ownerId: 'u1',
    });
    const res = await service.checkDrift(
      'p-drift',
      groupId.toString(),
      { sourceAvailable: false },
      scopeAll,
    );
    expect(res).toEqual({
      has_drift: false,
      changed_keys: [],
      changed_values: [],
      source_available: false,
    });
  });

  it('checkDrift returns no drift for the first generated version', async () => {
    const groupId = new ObjectId();
    documentGroupsCollection.findOne.mockResolvedValue({
      _id: groupId,
      projectId: 'p-drift',
      ownerId: 'u1',
    });
    documentVersionsCollection.countDocuments.mockResolvedValue(0);
    documentVersionsCollection.findOne.mockResolvedValue(null);
    const res = await service.checkDrift('p-drift', groupId.toString(), {}, scopeAll);
    expect(res.has_drift).toBe(false);
    expect(res.source_available).toBe(true);
  });

  it('reassignOwnedRecords emits owner_reassigned intents for affected groups', async () => {
    const groupId = new ObjectId();
    documentGroupsCollection.find.mockReturnValue({
      project: () => ({
        toArray: async () => [{ _id: groupId }],
      }),
    });
    documentGroupsCollection.updateMany.mockResolvedValue({ modifiedCount: 1 });
    const res = await service.reassignOwnedRecords('p-off', 'leaver', 'mgr', 42);
    expect(res.reassigned).toBe(1);
    expect(outbox.withOutbox).toHaveBeenCalled();
  });

  it('countOwnedRecords returns the Mongo count for a valid user', async () => {
    documentGroupsCollection.countDocuments.mockResolvedValue(7);
    await expect(service.countOwnedRecords('p1', 'u1')).resolves.toBe(7);
  });

  it('generateDocument rejects template revision files outside the project prefix', async () => {
    const templateId = new ObjectId();
    templatesCollection.findOne.mockResolvedValue({
      _id: templateId,
      projectId: 'p-bnd',
      status: 'published',
      currentRevision: 1,
    });
    templateRevisionsCollection.findOne.mockResolvedValue({
      projectId: 'p-bnd',
      templateId: templateId.toString(),
      version: 1,
      bucket: 'docs',
      objectKey: 'other-project/templates/x.docx',
    });
    await expect(
      service.generateDocument('p-bnd', 'u1', {
        template_id: templateId.toString(),
        context_type: 'deal',
        record_id: 'd-1',
        values_json: '{}',
      }),
    ).rejects.toMatchObject({
      error: expect.objectContaining({
        details: expect.objectContaining({ code: 'TEMPLATE_RENDER_FAILED' }),
      }),
    });
  });

  it('getTemplate rejects an invalid template id', async () => {
    await expect(service.getTemplate('p1', 'not-an-object-id')).rejects.toMatchObject({
      error: expect.objectContaining({ code: status.NOT_FOUND }),
    });
  });

  it('getTemplate rejects a missing revision when an explicit version is requested', async () => {
    const templateId = new ObjectId();
    templatesCollection.findOne.mockResolvedValue({
      _id: templateId,
      projectId: 'p-get',
      currentRevision: 1,
    });
    templateRevisionsCollection.findOne.mockResolvedValue(null);
    await expect(service.getTemplate('p-get', templateId.toString(), 99)).rejects.toMatchObject({
      error: expect.objectContaining({ code: status.NOT_FOUND }),
    });
  });

  it('listTemplates applies an explicit status filter', async () => {
    templatesCollection.find.mockReturnValue({
      sort: () => ({ toArray: async () => [] }),
    });
    await service.listTemplates('p-1', undefined, undefined, 'draft');
    expect(templatesCollection.find.mock.calls[0][0].status).toBe('draft');
  });

  it('createTemplate rejects malformed ABAC write predicates before touching storage', async () => {
    await expect(
      service.createTemplate(
        'p-1',
        'u-1',
        {
          name: 'Tpl',
          context_type: 'deal',
          bucket: 'docs',
          object_key: 'p-1/templates/x.docx',
        },
        undefined,
        { present: true, malformed: true },
      ),
    ).rejects.toMatchObject({
      error: expect.objectContaining({ code: status.PERMISSION_DENIED }),
    });
    expect(s3.getObjectBuffer).not.toHaveBeenCalled();
  });

  it('createTemplate rejects unknown declared variables for the context catalog', async () => {
    s3.getObjectBuffer.mockResolvedValue(await templateDocxBuffer('{{not.in.catalog}}'));
    await expect(
      service.createTemplate('p-1', 'u-1', {
        name: 'Tpl',
        context_type: 'deal',
        bucket: 'docs',
        object_key: 'p-1/templates/x.docx',
      }),
    ).rejects.toMatchObject({
      error: expect.objectContaining({
        code: status.INVALID_ARGUMENT,
        details: expect.objectContaining({ code: 'UNKNOWN_VARIABLES' }),
      }),
    });
  });

  it('createTemplateRevision updates the name without creating a revision when no file is supplied', async () => {
    const templateId = new ObjectId();
    templatesCollection.findOne
      .mockResolvedValueOnce({
        _id: templateId,
        projectId: 'p-rev',
        name: 'Old',
        contextType: 'deal',
        currentRevision: 1,
        draftRevision: 1,
      })
      .mockResolvedValueOnce({
        _id: templateId,
        projectId: 'p-rev',
        name: 'Renamed',
        contextType: 'deal',
        currentRevision: 1,
        draftRevision: 1,
      });
    templatesCollection.updateOne.mockResolvedValue({});
    const res = await service.createTemplateRevision('p-rev', templateId.toString(), 'u1', {
      name: '  Renamed ',
    });
    expect(res.name).toBe('Renamed');
    expect(templateRevisionsCollection.insertOne).not.toHaveBeenCalled();
  });

  it('archiveTemplate returns NOT_FOUND when the template does not exist', async () => {
    templatesCollection.findOneAndUpdate = jest.fn().mockResolvedValue(null);
    await expect(
      service.archiveTemplate('p-arch', new ObjectId().toString(), 'u-1'),
    ).rejects.toMatchObject({
      error: expect.objectContaining({ code: status.NOT_FOUND }),
    });
  });

  it('listDocuments applies owner, template, date, generated and search filters', async () => {
    documentGroupsCollection.countDocuments.mockResolvedValue(0);
    documentGroupsCollection.find.mockReturnValue({
      sort: () => ({
        skip: () => ({
          limit: () => ({ toArray: async () => [] }),
        }),
      }),
    });
    documentVersionsCollection.find.mockReturnValue({ toArray: async () => [] });
    await service.listDocuments(
      'p-filt',
      {
        contextType: 'deal',
        recordId: 'd-1',
        ownerId: 'u-owner',
        templateId: 'tpl-1',
        hasDrift: true,
        from: 100,
        to: 200,
        search: 'offer',
        sourceKind: 'generated',
        pageIndex: 0,
        pageSize: 10,
      },
      scopeAll,
    );
    const filter = documentGroupsCollection.find.mock.calls[0][0];
    const clauses = (filter.$and ?? [filter]) as Record<string, unknown>[];
    expect(clauses).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ projectId: 'p-filt' }),
        { contextType: 'deal' },
        { contextRecordId: 'd-1' },
        { ownerId: 'u-owner' },
        { templateId: 'tpl-1' },
        { driftStale: true },
        { createdAt: { $gte: 100 } },
        { createdAt: { $lte: 200 } },
        { generatedVia: { $ne: 'upload' } },
        expect.objectContaining({ $or: expect.any(Array) }),
      ]),
    );
  });

  it('listDocuments returns an empty page for chat context without querying Mongo', async () => {
    const res = await service.listDocuments(
      'p-chat',
      { contextType: 'chat', recordId: 'conv-1', pageIndex: 0, pageSize: 10 },
      scopeAll,
    );
    expect(res).toEqual({ list: [], total: 0 });
    expect(documentGroupsCollection.find).not.toHaveBeenCalled();
  });

  it('getDownloadUrl masks versions whose object key is outside the project prefix', async () => {
    const versionId = new ObjectId();
    const groupId = new ObjectId();
    documentVersionsCollection.findOne.mockResolvedValue({
      _id: versionId,
      projectId: 'p-dl',
      documentGroupId: groupId.toString(),
      bucket: 'docs',
      objectKey: 'other-project/files/x.pdf',
    });
    documentGroupsCollection.findOne.mockResolvedValue({
      _id: groupId,
      projectId: 'p-dl',
      ownerId: 'u1',
    });
    await expect(service.getDownloadUrl('p-dl', versionId.toString(), 0, scopeAll)).rejects.toMatchObject(
      {
        error: expect.objectContaining({ code: status.NOT_FOUND }),
      },
    );
  });

  it('getDownloadUrl fails closed for chat attachments when the chat client is not configured', async () => {
    mockChatAttachmentDocs();
    const svc = new DocumentsService(mongo, s3, outbox, new DocxValidator());
    await expect(
      svc.getDownloadUrl('p-9', chatVersionOid.toString(), 0, scopeAll),
    ).rejects.toMatchObject({
      error: expect.objectContaining({ code: status.UNAVAILABLE }),
    });
  });

  it('reassignContactDocuments is a no-op when merge sources are empty', async () => {
    documentGroupsCollection.updateMany = jest.fn();
    await expect(service.reassignContactDocuments('p-1', ['  '], 'c-new')).resolves.toEqual({
      groups: 0,
      versions: 0,
    });
    expect(documentGroupsCollection.updateMany).not.toHaveBeenCalled();
  });
});

describe('DocxValidator (FR-MDOC-9/10)', () => {
  const v = new DocxValidator();

  it('accepts a genuine safe DOCX', async () => {
    const buf = await validDocxBuffer();
    expect(() => v.validate(buf)).not.toThrow();
  });

  it('rejects a non-OOXML file', () => {
    expect(() => v.validate(Buffer.from('not a zip at all'))).toThrow(RpcException);
  });

  it('rejects XXE (DOCTYPE/ENTITY) markers in the archive bytes', async () => {
    const base = await validDocxBuffer();
    const withXxe = Buffer.concat([base, Buffer.from('<!DOCTYPE foo [ <!ENTITY x "y"> ]>')]);
    expect(() => v.validate(withXxe)).toThrow(RpcException);
  });

  it('rejects DDEAUTO field links', async () => {
    const base = await validDocxBuffer();
    const withDde = Buffer.concat([base, Buffer.from('DDEAUTO c:\\\\evil.exe')]);
    expect(() => v.validate(withDde)).toThrow(RpcException);
  });
});
