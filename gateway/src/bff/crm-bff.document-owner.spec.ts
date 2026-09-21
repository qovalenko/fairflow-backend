import { of, throwError } from 'rxjs';
import { ForbiddenException, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { status as GrpcStatus } from '@grpc/grpc-js';
import type { ClientGrpcProxy } from '@nestjs/microservices';
import { CrmBffController } from './crm-bff.controller';
import type { GatewayOutboundMetadataService } from './gateway-outbound-metadata.service';

/**
 * B2 — what the BFF sends to documents on generate/upload.
 *
 * 1. The source record's owner travels as `context_owner_id` /
 *    `context_owner_department_id` (reporting), NEVER as `owner_id`: `owner_id`
 *    is the field documents gates reads on, so putting the deal's assignee there
 *    404'd the author out of the document he had just generated.
 * 2. The donor resolution is DETERMINISTIC: a donor fault propagates (403/404/503)
 *    instead of silently degrading to an empty owner snapshot — the previous
 *    blanket `catch {}` made the stored data depend on a neighbour's health.
 * 3. m3: the department is taken with one uniform mapping for every context; it
 *    is empty for order/contact because those contracts carry no department field
 *    (orders has no `departmentId` at all), not because of a hardcoded ''.
 */
describe('CrmBffController document context-owner snapshot (B2)', () => {
  type Payloads = Record<string, unknown>[];

  function build(opts: { deal?: () => unknown; order?: () => unknown; company?: () => unknown }) {
    const generated: Payloads = [];
    const uploaded: Payloads = [];
    // X3: the S3 write. It must not happen before the donor has had its say.
    const uploadRecordDocument = jest.fn(async () => ({
      bucket: 'fairflow-documents',
      objectKey: 'p1/uploads/deal/d1/uuid-f.pdf',
      fileHash: 'h',
      sizeBytes: 4,
      mimeType: 'application/pdf',
    }));
    const pipeSvc = {
      resolveDocumentVariables: () => of({ values: { 'deal.amount': '10' }, source_hash: 'h' }),
      getDeal: () => (opts.deal ? opts.deal() : of({})),
    };
    const ordersSvc = {
      requestOrderDocument: () => of({ values: {}, source_hash: '' }),
      getOrder: () => (opts.order ? opts.order() : of({})),
    };
    const companySvc = {
      resolveDocumentVariables: () => of({ values: {}, source_hash: '' }),
      getCompany: () => (opts.company ? opts.company() : of({})),
    };
    const documentsSvc = {
      generateDocument: (p: Record<string, unknown>) => {
        generated.push(p);
        return of({ group: { group_id: 'g1' }, version: { version_id: 'v1' } });
      },
      uploadDocument: (p: Record<string, unknown>) => {
        uploaded.push(p);
        return of({ group: { group_id: 'g1' }, version: { version_id: 'v1' } });
      },
    };
    // control: GetProject for the `project.name` global (fail-soft, irrelevant here).
    const projectSvc = { getProject: () => of({ name: 'P' }) };

    const clientOf = (svc: unknown) => ({ getService: () => svc }) as unknown as ClientGrpcProxy;
    const nullClient = { getService: () => ({}) } as unknown as ClientGrpcProxy;
    const outboundMeta = { build: () => ({}) } as unknown as GatewayOutboundMetadataService;

    const ctrl = new CrmBffController(
      clientOf(pipeSvc), // PIPE
      clientOf(ordersSvc), // ORDERS
      nullClient, // PRODUCT
      nullClient, // ACTIVITY
      clientOf(documentsSvc), // DOCUMENTS
      nullClient, // REPORTS
      nullClient, // AUTOMATION
      clientOf(projectSvc), // CONTROL
      nullClient, // CONTACT
      clientOf(companySvc), // COMPANY
      outboundMeta,
      { uploadRecordDocument } as never, // docStorage
      { s3DocumentsBucket: 'fairflow-documents' } as never, // config (X4)
      { resolveNames: async () => new Map() } as never, // identity (TODO-207)
      {} as never, // reportRunNames (не используется в этом сценарии)
    );
    ctrl.onModuleInit();
    return { ctrl, generated, uploaded, uploadRecordDocument };
  }

  /** Fastify multipart request carrying one file part + the given form fields. */
  function multipartReq(fields: Record<string, string>) {
    const parts: unknown[] = [
      {
        type: 'file',
        filename: 'f.pdf',
        mimetype: 'application/pdf',
        toBuffer: async () => Buffer.from('%PDF'),
        file: { truncated: false },
      },
      ...Object.entries(fields).map(([fieldname, value]) => ({ type: 'field', fieldname, value })),
    ];
    return {
      headers: { 'x-project-id': 'p1' },
      user: { userId: 'u1' },
      __projectRole: 'member',
      query: {},
      isMultipart: () => true,
      parts: async function* () {
        for (const p of parts) yield p;
      },
    } as never;
  }

  const req = { headers: { 'x-project-id': 'p1' }, __projectRole: 'member' } as never;
  const grpcErr = (code: number) => () => throwError(() => Object.assign(new Error('x'), { code }));

  it('generate: sends context_owner_* and never owner_id', async () => {
    const { ctrl, generated } = build({
      deal: () => of({ id: 'd1', assignee_id: 'u-assignee', department_id: 'dep-9' }),
    });

    await ctrl.generateDocument(
      req,
      { templateId: 't1', contextType: 'deal', recordId: 'd1' },
      'p1',
    );

    expect(generated).toHaveLength(1);
    const payload = generated[0];
    expect(payload.context_owner_id).toBe('u-assignee');
    expect(payload.context_owner_department_id).toBe('dep-9');
    // The ACL owner is resolved by the domain from x-user-id — not sent from here.
    expect(payload).not.toHaveProperty('owner_id');
    expect(payload).not.toHaveProperty('owner_department_id');
  });

  it('upload: sends context_owner_* for a record context', async () => {
    const { ctrl, uploaded } = build({
      company: () => of({ id: 'co1', owner_id: 'u-am', department_id: 'dep-3' }),
    });

    await ctrl.uploadDocument(
      req,
      {
        name: 'Скан',
        contextType: 'company',
        recordId: 'co1',
        // X4: the pointer must name the configured bucket (a foreign one is refused).
        bucket: 'fairflow-documents',
        objectKey: 'p1/documents/company/co1/f.pdf',
        mimeType: 'application/pdf',
        sizeBytes: 3,
        fileHash: '',
        projectId: 'p1',
      } as never,
      'p1',
    );

    expect(uploaded).toHaveLength(1);
    expect(uploaded[0].context_owner_id).toBe('u-am');
    expect(uploaded[0].context_owner_department_id).toBe('dep-3');
    expect(uploaded[0]).not.toHaveProperty('owner_id');
  });

  it('m3: an order carries no department — the same mapping yields an empty one', async () => {
    const { ctrl, generated } = build({
      order: () => of({ id: 'o1', assignee_id: 'u-op' }),
    });

    await ctrl.generateDocument(
      req,
      { templateId: 't1', contextType: 'order', recordId: 'o1' },
      'p1',
    );

    expect(generated[0].context_owner_id).toBe('u-op');
    expect(generated[0].context_owner_department_id).toBe('');
  });

  it('donor UNAVAILABLE → 503, and NOTHING is written with a silently changed owner', async () => {
    const { ctrl, generated } = build({ deal: grpcErr(GrpcStatus.UNAVAILABLE) });

    await expect(
      ctrl.generateDocument(req, { templateId: 't1', contextType: 'deal', recordId: 'd1' }, 'p1'),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(generated).toHaveLength(0);
  });

  it('donor PERMISSION_DENIED → 403 (the donor is the PEP of the source record)', async () => {
    const { ctrl, generated } = build({ deal: grpcErr(GrpcStatus.PERMISSION_DENIED) });

    await expect(
      ctrl.generateDocument(req, { templateId: 't1', contextType: 'deal', recordId: 'd1' }, 'p1'),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(generated).toHaveLength(0);
  });

  it('donor NOT_FOUND → 404', async () => {
    const { ctrl } = build({ deal: grpcErr(GrpcStatus.NOT_FOUND) });

    await expect(
      ctrl.generateDocument(req, { templateId: 't1', contextType: 'deal', recordId: 'd1' }, 'p1'),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  /**
   * X3 — the multipart upload put the bytes in S3 FIRST and asked the donor
   * SECOND. `resolveContextOwner` is the PEP for the source record, so a caller
   * with no access to the deal still got a 403 — after up to 20 MB of their file
   * had been written into the private bucket, referenced by no document row and
   * therefore never cleaned up. The check now precedes the write.
   */
  describe('X3: a refused upload leaves nothing in the bucket', () => {
    const fields = { name: 'Скан', contextType: 'deal', recordId: 'd1', projectId: 'p1' };

    it('donor PERMISSION_DENIED → 403 and the file never reaches S3', async () => {
      const { ctrl, uploaded, uploadRecordDocument } = build({
        deal: grpcErr(GrpcStatus.PERMISSION_DENIED),
      });

      await expect(
        ctrl.uploadDocument(multipartReq(fields), undefined as never, 'p1'),
      ).rejects.toBeInstanceOf(ForbiddenException);

      expect(uploadRecordDocument).not.toHaveBeenCalled();
      expect(uploaded).toHaveLength(0);
    });

    it('donor NOT_FOUND → 404 and the file never reaches S3', async () => {
      const { ctrl, uploadRecordDocument } = build({ deal: grpcErr(GrpcStatus.NOT_FOUND) });

      await expect(
        ctrl.uploadDocument(multipartReq(fields), undefined as never, 'p1'),
      ).rejects.toBeInstanceOf(NotFoundException);

      expect(uploadRecordDocument).not.toHaveBeenCalled();
    });

    it('donor UNAVAILABLE → 503 and the file never reaches S3', async () => {
      const { ctrl, uploadRecordDocument } = build({ deal: grpcErr(GrpcStatus.UNAVAILABLE) });

      await expect(
        ctrl.uploadDocument(multipartReq(fields), undefined as never, 'p1'),
      ).rejects.toBeInstanceOf(ServiceUnavailableException);

      expect(uploadRecordDocument).not.toHaveBeenCalled();
    });

    it('THE SUCCESS PATH IS INTACT: allowed → file stored, pointer + owner forwarded', async () => {
      const { ctrl, uploaded, uploadRecordDocument } = build({
        deal: () => of({ id: 'd1', assignee_id: 'u-assignee', department_id: 'dep-9' }),
      });

      await ctrl.uploadDocument(multipartReq(fields), undefined as never, 'p1');

      expect(uploadRecordDocument).toHaveBeenCalledWith(
        expect.objectContaining({ projectId: 'p1', contextType: 'deal', recordId: 'd1' }),
      );
      expect(uploaded).toHaveLength(1);
      expect(uploaded[0].object_key).toBe('p1/uploads/deal/d1/uuid-f.pdf');
      expect(uploaded[0].bucket).toBe('fairflow-documents');
      expect(uploaded[0].context_owner_id).toBe('u-assignee');
      expect(uploaded[0].context_owner_department_id).toBe('dep-9');
      expect(uploaded[0].record_id).toBe('d1');
      expect(uploaded[0].name).toBe('Скан');
    });

    it('contextType=none has no source record to gate on — the upload still works', async () => {
      const { ctrl, uploaded, uploadRecordDocument } = build({});

      await ctrl.uploadDocument(
        multipartReq({ name: 'Без привязки', contextType: 'none', projectId: 'p1' }),
        undefined as never,
        'p1',
      );

      expect(uploadRecordDocument).toHaveBeenCalledTimes(1);
      expect(uploaded).toHaveLength(1);
      expect(uploaded[0].context_owner_id).toBe('');
    });
  });
});
