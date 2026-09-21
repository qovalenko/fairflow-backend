/**
 * [T-025] gateway BFF documents-surface fixes:
 *  1) `GET /api/v1/document-variables` — static variable catalog per contextType
 *     (route did NOT exist before T-025 → 404); 400 on missing/invalid contextType.
 *  2) proto int64 `total` (ListDocuments) + `size_bytes` (DocumentVersion) decode
 *     as a loader Long `{low,high}`; the BFF must surface plain JS numbers.
 */
import { of } from 'rxjs';
import { BadRequestException, ForbiddenException } from '@nestjs/common';
import type { ClientGrpcProxy } from '@nestjs/microservices';
import { CrmBffController } from './crm-bff.controller';

function stubClient(service: Record<string, unknown> = {}): ClientGrpcProxy {
  return { getService: () => service } as unknown as ClientGrpcProxy;
}

/** X4: the one bucket the gateway is configured to write documents into. */
const DOCUMENTS_BUCKET = 'fairflow-documents';

function build(
  documentsService: Record<string, unknown>,
  docStorage: Record<string, unknown> = {},
  ordersService: Record<string, unknown> = {},
) {
  const outboundMeta = { build: () => ({}) } as never;
  const ctrl = new CrmBffController(
    stubClient(), // pipe
    stubClient(ordersService), // orders
    stubClient(), // product
    stubClient(), // activity
    stubClient(documentsService), // documents (5th)
    stubClient(), // reports
    stubClient(), // automation
    stubClient(), // control
    stubClient(), // contact
    stubClient(), // company
    outboundMeta,
    docStorage as never, // docStorage
    { s3DocumentsBucket: DOCUMENTS_BUCKET } as never, // config (X4)
    { resolveNames: async () => new Map() } as never, // identity (TODO-207)
    {} as never, // reportRunNames (не используется в этом сценарии)
  );
  ctrl.onModuleInit();
  return ctrl;
}

const req = { user: { userId: 'u1' } } as never;

/**
 * Build a fake Fastify multipart request: `isMultipart()` true + a `parts()`
 * async iterator yielding one file part (unless `file` is null) and the given
 * form fields. Mirrors the shape `readMultipart` consumes.
 */
function multipartReq(opts: {
  file?: { buffer: Buffer; filename?: string; mimetype?: string } | null;
  fields?: Record<string, string>;
  query?: Record<string, string>;
}) {
  const parts: unknown[] = [];
  if (opts.file) {
    parts.push({
      type: 'file',
      filename: opts.file.filename ?? 'f.docx',
      mimetype: opts.file.mimetype ?? 'application/octet-stream',
      toBuffer: async () => opts.file!.buffer,
      file: { truncated: false },
    });
  }
  for (const [fieldname, value] of Object.entries(opts.fields ?? {})) {
    parts.push({ type: 'field', fieldname, value });
  }
  return {
    user: { userId: 'u1' },
    query: opts.query ?? {},
    isMultipart: () => true,
    parts: async function* () {
      for (const p of parts) yield p;
    },
  } as never;
}

describe('[T-025] CrmBffController document-variables route', () => {
  it('returns the order catalog with globals for contextType=order', async () => {
    const ctrl = build({});
    const res = (await ctrl.listDocumentVariables(req, 'order', 'p1')) as {
      items: { key: string; source: string; required: boolean }[];
    };
    const keys = res.items.map((i) => i.key);
    expect(keys).toContain('order.number');
    expect(keys).toContain('project.name');
    expect(keys).toContain('today');
    // required flag preserved from donor REQUIRED consts
    expect(res.items.find((i) => i.key === 'order.number')?.required ?? false).toBe(true);
  });

  it('appends dynamic order.field.* from GetOrderType (FR-DOCS-310)', async () => {
    const ctrl = build(
      {},
      {},
      {
        getOrderType: jest.fn(() =>
          of({
            revision: {
              fields: [{ key: 'city', label: 'Город', required: false, deprecated: false }],
            },
          }),
        ),
      },
    );
    const res = (await ctrl.listDocumentVariables(req, 'order', 'p1', undefined, 'ot-1')) as {
      items: { key: string }[];
    };
    expect(res.items.map((i) => i.key)).toContain('order.field.city');
  });

  it('returns company catalog (inn required) for contextType=company', async () => {
    const ctrl = build({});
    const res = (await ctrl.listDocumentVariables(req, 'company', 'p1')) as {
      items: { key: string; required: boolean }[];
    };
    expect(res.items.find((i) => i.key === 'company.inn')?.required).toBe(true);
  });

  it('400s when contextType is missing or invalid', async () => {
    const ctrl = build({});
    await expect(ctrl.listDocumentVariables(req, undefined, 'p1')).rejects.toThrow(
      BadRequestException,
    );
    await expect(ctrl.listDocumentVariables(req, 'widget', 'p1')).rejects.toThrow(
      BadRequestException,
    );
  });
});

describe('[T-025] CrmBffController int64 Long → number mapping', () => {
  it('coerces ListDocuments total from a Long {low,high} to a number', async () => {
    const ctrl = build({
      listDocuments: jest.fn(() =>
        of({
          list: [{ group_id: 'g1', size_bytes: { low: 5, high: 0, unsigned: false } }],
          total: { low: 42, high: 0, unsigned: false },
        }),
      ),
    });
    const res = (await ctrl.listDocuments(req, 'proj-1')) as { total: unknown; list: unknown[] };
    expect(res.total).toBe(42);
    expect(typeof res.total).toBe('number');
    expect(res.list).toHaveLength(1);
  });

  it('coerces DocumentVersion size_bytes (Long) to a number in list-versions', async () => {
    const ctrl = build({
      listVersions: jest.fn(() =>
        of({ list: [{ version_id: 'v1', size_bytes: { low: 123456, high: 0, unsigned: false } }] }),
      ),
    });
    const res = (await ctrl.listVersions(req, 'g1', 'proj-1')) as {
      items: { sizeBytes: unknown }[];
    };
    expect(res.items[0].sizeBytes).toBe(123456);
    expect(typeof res.items[0].sizeBytes).toBe('number');
  });

  it('passes through a plain-number total unchanged', async () => {
    const ctrl = build({
      listDocuments: jest.fn((..._a: unknown[]) => of({ list: [], total: 7 })),
    });
    const res = (await ctrl.listDocuments(req, 'proj-1')) as { total: unknown };
    expect(res.total).toBe(7);
  });
});

describe('[BX-DOCS-1] multipart DOCX upload → S3 pointer', () => {
  it('createTemplate: uploads the file, forwards the resolved storage pointer', async () => {
    const createTemplate = jest.fn((..._a: unknown[]) => of({ id: 't1' }));
    const uploadTemplateFile = jest.fn(async () => ({
      bucket: 'fairflow-documents',
      objectKey: 'proj-1/templates/uuid-tpl.docx',
      fileHash: 'abc123',
      sizeBytes: 2048,
      mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    }));
    const ctrl = build({ createTemplate }, { uploadTemplateFile });

    const r = multipartReq({
      file: { buffer: Buffer.from('PK-docx'), filename: 'tpl.docx' },
      fields: { name: 'КП', contextType: 'deal', orderTypeId: '' },
      query: { projectId: 'proj-1' },
    });
    await ctrl.createTemplate(r, undefined as never, 'proj-1');

    expect(uploadTemplateFile).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: 'proj-1', fileName: 'tpl.docx' }),
    );
    const sent = createTemplate.mock.calls[0][0] as Record<string, unknown>;
    expect(sent.project_id).toBe('proj-1');
    expect(sent.name).toBe('КП');
    expect(sent.context_type).toBe('deal');
    expect(sent.bucket).toBe('fairflow-documents');
    expect(sent.object_key).toBe('proj-1/templates/uuid-tpl.docx');
    expect(sent.file_hash).toBe('abc123');
    expect(sent.size_bytes).toBe(2048);
  });

  it('createTemplate: a multipart request with no file part is rejected (400)', async () => {
    const ctrl = build({ createTemplate: jest.fn() }, { uploadTemplateFile: jest.fn() });
    const r = multipartReq({ file: null, fields: { name: 'x', contextType: 'deal' } });
    await expect(ctrl.createTemplate(r, undefined as never, 'proj-1')).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('createTemplate: a sanitizer rejection from storage propagates (not swallowed)', async () => {
    const uploadTemplateFile = jest.fn(async () => {
      throw new Error('TEMPLATE_INVALID');
    });
    const createTemplate = jest.fn((..._a: unknown[]) => of({ id: 't1' }));
    const ctrl = build({ createTemplate }, { uploadTemplateFile });
    const r = multipartReq({
      file: { buffer: Buffer.from('bad'), filename: 'm.docx' },
      fields: { name: 'x', contextType: 'deal' },
      query: { projectId: 'proj-1' },
    });
    await expect(ctrl.createTemplate(r, undefined as never, 'proj-1')).rejects.toThrow(
      'TEMPLATE_INVALID',
    );
    expect(createTemplate).not.toHaveBeenCalled();
  });

  it('updateTemplate: metadata-only multipart (no file) updates name without a new pointer', async () => {
    const createTemplateRevision = jest.fn((..._a: unknown[]) => of({ id: 't1' }));
    const uploadTemplateFile = jest.fn();
    const ctrl = build({ createTemplateRevision }, { uploadTemplateFile });
    const r = multipartReq({ file: null, fields: { name: 'Новое имя' } });
    await ctrl.updateTemplate(r, 't1', 'proj-1', undefined as never);

    expect(uploadTemplateFile).not.toHaveBeenCalled();
    const sent = createTemplateRevision.mock.calls[0][0] as Record<string, unknown>;
    expect(sent.name).toBe('Новое имя');
    expect(sent.object_key).toBe(''); // no new revision
    expect(sent.bucket).toBe('');
  });

  it('uploadDocument: uploads arbitrary file and forwards the pointer + context', async () => {
    const uploadDocument = jest.fn((..._a: unknown[]) =>
      of({ group: { group_id: 'g1' }, version: {} }),
    );
    const uploadRecordDocument = jest.fn(async () => ({
      bucket: 'fairflow-documents',
      objectKey: 'proj-1/uploads/deal/d1/uuid-file.pdf',
      fileHash: 'h1',
      sizeBytes: 10,
      mimeType: 'application/pdf',
    }));
    const ctrl = build({ uploadDocument }, { uploadRecordDocument });
    const r = multipartReq({
      file: { buffer: Buffer.from('%PDF'), filename: 'file.pdf', mimetype: 'application/pdf' },
      fields: { name: 'file.pdf', contextType: 'deal', recordId: 'd1' },
      query: { projectId: 'proj-1' },
    });
    await ctrl.uploadDocument(r, undefined as never, 'proj-1');

    expect(uploadRecordDocument).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: 'proj-1', contextType: 'deal', recordId: 'd1' }),
    );
    const sent = uploadDocument.mock.calls[0][0] as Record<string, unknown>;
    expect(sent.object_key).toBe('proj-1/uploads/deal/d1/uuid-file.pdf');
    expect(sent.mime_type).toBe('application/pdf');
    expect(sent.record_id).toBe('d1');
  });

  it('createTemplate: still honours a legacy JSON pointer body (non-multipart)', async () => {
    const createTemplate = jest.fn((..._a: unknown[]) => of({ id: 't1' }));
    const uploadTemplateFile = jest.fn();
    const ctrl = build({ createTemplate }, { uploadTemplateFile });
    await ctrl.createTemplate(
      req,
      {
        name: 'x',
        contextType: 'deal',
        bucket: DOCUMENTS_BUCKET,
        objectKey: 'proj-1/templates/x.docx',
      } as never,
      'proj-1',
    );
    expect(uploadTemplateFile).not.toHaveBeenCalled();
    const sent = createTemplate.mock.calls[0][0] as Record<string, unknown>;
    expect(sent.bucket).toBe(DOCUMENTS_BUCKET);
    expect(sent.object_key).toBe('proj-1/templates/x.docx');
  });
});

/**
 * X4 — «клиент задаёт адрес хранилища». The JSON/back-compat branch of the upload
 * routes accepted `bucket` + `objectKey` from the request BODY, and the domain
 * validated only the key prefix. bucket/objectKey are not metadata: documents
 * persists them and later READS (`getObjectBuffer` when validating a template
 * revision) and PRESIGNS from exactly that address — so the caller could aim the
 * domain's S3 credentials at any bucket they could reach. Allowlist of one.
 */
describe('[X4] a storage pointer from the request body is not trusted', () => {
  it('uploadDocument: a foreign bucket is refused, nothing is written', async () => {
    const uploadDocument = jest.fn();
    const ctrl = build({ uploadDocument }, {});
    await expect(
      ctrl.uploadDocument(
        req,
        {
          name: 'Скан',
          contextType: 'none',
          bucket: 'attacker-controlled',
          objectKey: 'proj-1/uploads/none/x.pdf',
        } as never,
        'proj-1',
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(uploadDocument).not.toHaveBeenCalled();
  });

  it('uploadDocument: an objectKey outside the authorized project is refused', async () => {
    const uploadDocument = jest.fn();
    const ctrl = build({ uploadDocument }, {});
    await expect(
      ctrl.uploadDocument(
        req,
        {
          name: 'Скан',
          contextType: 'none',
          bucket: DOCUMENTS_BUCKET,
          objectKey: 'victim-proj/uploads/none/secret.pdf',
        } as never,
        'proj-1',
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(uploadDocument).not.toHaveBeenCalled();
  });

  it('uploadDocument: a body with no bucket is filled in from config, not left blank', async () => {
    const uploadDocument = jest.fn((..._a: unknown[]) =>
      of({ group: { group_id: 'g1' }, version: {} }),
    );
    const ctrl = build({ uploadDocument }, {});
    await ctrl.uploadDocument(
      req,
      {
        name: 'Скан',
        contextType: 'none',
        objectKey: 'proj-1/uploads/none/x.pdf',
      } as never,
      'proj-1',
    );
    const sent = uploadDocument.mock.calls[0][0] as Record<string, unknown>;
    expect(sent.bucket).toBe(DOCUMENTS_BUCKET);
    expect(sent.object_key).toBe('proj-1/uploads/none/x.pdf');
  });

  it('createTemplate: a foreign bucket is refused (the domain would FETCH from it)', async () => {
    const createTemplate = jest.fn();
    const ctrl = build({ createTemplate }, { uploadTemplateFile: jest.fn() });
    await expect(
      ctrl.createTemplate(
        req,
        {
          name: 'x',
          contextType: 'deal',
          bucket: 'internal-secrets',
          objectKey: 'proj-1/templates/x.docx',
        } as never,
        'proj-1',
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(createTemplate).not.toHaveBeenCalled();
  });

  it('updateTemplate: a foreign bucket is refused on the JSON branch', async () => {
    const createTemplateRevision = jest.fn();
    const ctrl = build({ createTemplateRevision }, { uploadTemplateFile: jest.fn() });
    await expect(
      ctrl.updateTemplate(req, 't1', 'proj-1', {
        name: 'x',
        bucket: 'internal-secrets',
        objectKey: 'proj-1/templates/x.docx',
      } as never),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(createTemplateRevision).not.toHaveBeenCalled();
  });

  it('multipart is unaffected: the pointer comes from storage, not from the body', async () => {
    const uploadDocument = jest.fn((..._a: unknown[]) =>
      of({ group: { group_id: 'g1' }, version: {} }),
    );
    const uploadRecordDocument = jest.fn(async () => ({
      bucket: DOCUMENTS_BUCKET,
      objectKey: 'proj-1/uploads/none/uuid-file.pdf',
      fileHash: 'h1',
      sizeBytes: 4,
      mimeType: 'application/pdf',
    }));
    const ctrl = build({ uploadDocument }, { uploadRecordDocument });
    const r = multipartReq({
      file: { buffer: Buffer.from('%PDF'), filename: 'file.pdf', mimetype: 'application/pdf' },
      fields: { name: 'file.pdf', contextType: 'none' },
      query: { projectId: 'proj-1' },
    });
    await ctrl.uploadDocument(r, undefined as never, 'proj-1');
    const sent = uploadDocument.mock.calls[0][0] as Record<string, unknown>;
    expect(sent.bucket).toBe(DOCUMENTS_BUCKET);
  });
});

describe('[BX-FIX-3] cross-project write IDOR — form projectId is never authoritative', () => {
  it('createTemplate: a `projectId` form field ≠ the guard-authorized project → 403, no write', async () => {
    const createTemplate = jest.fn();
    const uploadTemplateFile = jest.fn();
    const ctrl = build({ createTemplate }, { uploadTemplateFile });
    // Guard authorized 'proj-1' (query); attacker smuggles a victim project in the body.
    const r = multipartReq({
      file: { buffer: Buffer.from('PK'), filename: 'tpl.docx' },
      fields: { name: 'x', contextType: 'deal', projectId: 'victim-proj' },
      query: { projectId: 'proj-1' },
    });
    await expect(ctrl.createTemplate(r, undefined as never, 'proj-1')).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    expect(uploadTemplateFile).not.toHaveBeenCalled();
    expect(createTemplate).not.toHaveBeenCalled();
  });

  it('uploadDocument: a `projectId` form field ≠ the guard-authorized project → 403, no write', async () => {
    const uploadDocument = jest.fn();
    const uploadRecordDocument = jest.fn();
    const ctrl = build({ uploadDocument }, { uploadRecordDocument });
    const r = multipartReq({
      file: { buffer: Buffer.from('%PDF'), filename: 'file.pdf', mimetype: 'application/pdf' },
      fields: { name: 'file.pdf', contextType: 'deal', recordId: 'd1', projectId: 'victim-proj' },
      query: { projectId: 'proj-1' },
    });
    await expect(ctrl.uploadDocument(r, undefined as never, 'proj-1')).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    expect(uploadRecordDocument).not.toHaveBeenCalled();
    expect(uploadDocument).not.toHaveBeenCalled();
  });

  it('createTemplate: an empty authorized projectId is rejected (no guard-bypass write)', async () => {
    const createTemplate = jest.fn();
    const uploadTemplateFile = jest.fn();
    const ctrl = build({ createTemplate }, { uploadTemplateFile });
    // No query/header project context → the guards would `return true`; the handler
    // must still refuse to write, even if the body carries a project.
    const r = multipartReq({
      file: { buffer: Buffer.from('PK'), filename: 'tpl.docx' },
      fields: { name: 'x', contextType: 'deal', projectId: 'victim-proj' },
    });
    await expect(ctrl.createTemplate(r, undefined as never, '')).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(uploadTemplateFile).not.toHaveBeenCalled();
    expect(createTemplate).not.toHaveBeenCalled();
  });

  it('uploadDocument: a `projectId` form field EQUAL to the authorized project is accepted', async () => {
    const uploadDocument = jest.fn((..._a: unknown[]) =>
      of({ group: { group_id: 'g1' }, version: {} }),
    );
    const uploadRecordDocument = jest.fn(async () => ({
      bucket: 'fairflow-documents',
      objectKey: 'proj-1/uploads/deal/d1/uuid-file.pdf',
      fileHash: 'h1',
      sizeBytes: 10,
      mimeType: 'application/pdf',
    }));
    const ctrl = build({ uploadDocument }, { uploadRecordDocument });
    const r = multipartReq({
      file: { buffer: Buffer.from('%PDF'), filename: 'file.pdf', mimetype: 'application/pdf' },
      fields: { name: 'file.pdf', contextType: 'deal', recordId: 'd1', projectId: 'proj-1' },
      query: { projectId: 'proj-1' },
    });
    await ctrl.uploadDocument(r, undefined as never, 'proj-1');
    expect(uploadRecordDocument).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: 'proj-1' }),
    );
  });

  it('uploadDocument: rejects contextType=chat on the generic route', async () => {
    const uploadDocument = jest.fn();
    const uploadRecordDocument = jest.fn();
    const ctrl = build({ uploadDocument }, { uploadRecordDocument });
    const r = multipartReq({
      file: { buffer: Buffer.from('%PDF'), filename: 'file.pdf', mimetype: 'application/pdf' },
      fields: { name: 'file.pdf', contextType: 'chat', recordId: 'conv-1' },
      query: { projectId: 'proj-1' },
    });
    await expect(ctrl.uploadDocument(r, undefined as never, 'proj-1')).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(uploadRecordDocument).not.toHaveBeenCalled();
    expect(uploadDocument).not.toHaveBeenCalled();
  });

  it('createTemplate: a legacy JSON body projectId ≠ the guard-authorized project → 403', async () => {
    const createTemplate = jest.fn();
    const uploadTemplateFile = jest.fn();
    const ctrl = build({ createTemplate }, { uploadTemplateFile });
    await expect(
      ctrl.createTemplate(
        req,
        {
          name: 'x',
          contextType: 'deal',
          projectId: 'victim-proj',
          bucket: 'b',
          objectKey: 'k',
        } as never,
        'proj-1',
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(createTemplate).not.toHaveBeenCalled();
  });
});

describe('[BX-DOCS-4] template download → presigned URL', () => {
  it('downloadTemplate: forwards id/version/ttl and returns {url, expiresAt}', async () => {
    const getTemplateDownloadUrl = jest.fn((..._a: unknown[]) =>
      of({ url: 'https://s3/presigned', expires_at: 1234 }),
    );
    const ctrl = build({ getTemplateDownloadUrl });
    const res = (await ctrl.downloadTemplate(req, 't1', 'proj-1', '3', '600')) as {
      url: string;
      expiresAt: number;
    };
    expect(res).toEqual({ url: 'https://s3/presigned', expiresAt: 1234 });
    const sent = getTemplateDownloadUrl.mock.calls[0][0] as Record<string, unknown>;
    expect(sent.project_id).toBe('proj-1');
    expect(sent.id).toBe('t1');
    expect(sent.version).toBe(3);
    expect(sent.ttl_sec).toBe(600);
  });

  it('downloadTemplate: defaults version/ttl to 0 (domain picks current revision)', async () => {
    const getTemplateDownloadUrl = jest.fn((..._a: unknown[]) =>
      of({ url: 'https://s3/x', expires_at: 9 }),
    );
    const ctrl = build({ getTemplateDownloadUrl });
    await ctrl.downloadTemplate(req, 't1', 'proj-1');
    const sent = getTemplateDownloadUrl.mock.calls[0][0] as Record<string, unknown>;
    expect(sent.version).toBe(0);
    expect(sent.ttl_sec).toBe(0);
  });
});
