/**
 * P0 wave — "the domain can do it, the user never sees it".
 *
 * Regression tests for fields that existed end to end (proto + domain + FE) but were
 * dropped by the CRM BFF mapping layer. Each test asserts BOTH directions where the
 * field travels in both: what leaves the gateway towards the domain, and what the
 * gateway returns to the browser.
 *
 * Covered gaps:
 *  - GAP-DEALS-010     createDeal forwarded 10 of 18 CreateDealRequest fields
 *  - GAP-DEALS-140/180 updateDeal forwarded 7 of 13 UpdateDealRequest fields
 *  - GAP-DEALS-130     reopen gated on `deals:manage`, a permission manager lacks
 *  - GAP-DEALS-200     `GET /v1/pipelines/:id` did not exist (pipeline editor 404)
 *  - GAP-ORDERS-180/300/150/210  FE sends `customFields`, BFF read `body.fields`
 *  - GAP-PRODUCTS-160  `prefill` is a proto Struct; a plain map encodes to 0 bytes
 *  - GAP-DOCS-115/185  donor PERMISSION_DENIED/NOT_FOUND swallowed by fail-soft
 *  - GAP-DOCS-190      the source record's owner never reached documents at all
 *                      (B2: it now travels as `context_owner_*`, NOT as `owner_id`
 *                      — see crm-bff.document-owner.spec.ts for the ACL invariant)
 *  - GAP-DOCS-110/350  checkDrift never sent the real source_hash
 */
import { of, throwError } from 'rxjs';
import { ForbiddenException, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { status as GrpcStatus } from '@grpc/grpc-js';
import type { ClientGrpcProxy } from '@nestjs/microservices';
import { CrmBffController } from './crm-bff.controller';

type Svc = Record<string, unknown>;

function stubClient(service: Svc = {}): ClientGrpcProxy {
  return { getService: () => service } as unknown as ClientGrpcProxy;
}

/** Records the request object handed to a gRPC stub and answers with `reply`. */
function spy(reply: unknown = {}) {
  const calls: Record<string, unknown>[] = [];
  const fn = (payload: Record<string, unknown>) => {
    calls.push(payload);
    return of(reply);
  };
  return Object.assign(fn, { calls });
}

function build(services: {
  pipe?: Svc;
  orders?: Svc;
  product?: Svc;
  documents?: Svc;
  contact?: Svc;
  company?: Svc;
}) {
  const ctrl = new CrmBffController(
    stubClient(services.pipe ?? {}),
    stubClient(services.orders ?? {}),
    stubClient(services.product ?? {}),
    stubClient(), // activity
    stubClient(services.documents ?? {}),
    stubClient(), // reports
    stubClient(), // automation
    stubClient(), // control
    stubClient(services.contact ?? {}),
    stubClient(services.company ?? {}),
    { build: () => ({}) } as never,
    {} as never,
    { s3DocumentsBucket: 'fairflow-documents' } as never, // config (X4)
    { resolveNames: async () => new Map() } as never, // identity (TODO-207)
    {} as never, // reportRunNames (не используется в этом сценарии)
  );
  ctrl.onModuleInit();
  return ctrl;
}

const req = { user: { userId: 'u1' }, headers: {} } as never;

describe('GAP-DEALS-010 — createDeal forwards every CreateDealRequest field', () => {
  it('sends the 8 previously-dropped fields to pipe', async () => {
    const createDeal = spy({ id: 'd1' });
    // A body-supplied contactId/companyId is an attach, so createDeal now resolves the
    // donors first (fail-closed read gate — see crm-bff.deals-module.spec.ts). Visible
    // donors here: the passthrough assertion is about the fields, not the gate.
    const ctrl = build({
      pipe: { createDeal },
      contact: { getContact: () => of({ id: 'c1', first_name: 'Иван', last_name: 'Петров' }) },
      company: { getCompany: () => of({ id: 'co1', name: 'ООО Ромашка' }) },
    });

    await ctrl.createDeal(
      req,
      {
        name: 'Сделка',
        amount: 100,
        currency: 'RUB',
        pipelineId: 'pl1',
        stageId: 'st1',
        contactId: 'c1',
        companyId: 'co1',
        source: 'сайт',
        assigneeId: 'u2',
        // ↓ these used to be silently discarded
        productId: 'pr1',
        departmentId: 'dep1',
        expectedCloseDate: 1_755_300_000,
        probability: 40,
        lightName: 'Иван',
        lightPhone: '+70000000000',
        lightEmail: 'i@example.com',
        lightCompanyName: 'ООО Ромашка',
      },
      'p1',
    );

    expect(createDeal.calls[0]).toMatchObject({
      project_id: 'p1',
      product_id: 'pr1',
      department_id: 'dep1',
      expected_close_date: 1_755_300_000,
      probability: 40,
      light_name: 'Иван',
      light_phone: '+70000000000',
      light_email: 'i@example.com',
      light_company_name: 'ООО Ромашка',
    });
  });

  it('still takes projectId from the query, never from the body', async () => {
    const createDeal = spy({ id: 'd1' });
    const ctrl = build({ pipe: { createDeal } });
    await expect(
      ctrl.createDeal(req, { name: 'x', projectId: 'OTHER' }, 'p1'),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('returns the round-tripped fields to the client (domain → FE mapping)', async () => {
    const ctrl = build({
      pipe: {
        createDeal: () =>
          of({
            id: 'd1',
            product_id: 'pr1',
            department_id: 'dep1',
            expected_close_date: 1_755_300_000,
            probability: 40,
            light_name: 'Иван',
            light_phone: '+70000000000',
            light_email: 'i@example.com',
            light_company_name: 'ООО Ромашка',
          }),
      },
    });
    const res = (await ctrl.createDeal(req, { name: 'x' }, 'p1')) as Record<string, unknown>;
    expect(res).toMatchObject({
      productId: 'pr1',
      departmentId: 'dep1',
      expectedCloseDate: 1_755_300_000,
      probability: 40,
      lightName: 'Иван',
      lightPhone: '+70000000000',
      lightEmail: 'i@example.com',
      lightCompanyName: 'ООО Ромашка',
    });
  });

  it('returns FR-DEALS-180 derived timing fields to the client', async () => {
    const ctrl = build({
      pipe: {
        createDeal: () =>
          of({
            id: 'd1',
            days_on_stage: 12,
            is_stalled: true,
            stage_return_count: 2,
            total_time_on_stage_days: 20,
          }),
      },
    });
    const res = (await ctrl.createDeal(req, { name: 'x' }, 'p1')) as Record<string, unknown>;
    expect(res).toMatchObject({
      daysOnStage: 12,
      isStalled: true,
      stageReturnCount: 2,
      totalTimeOnStageDays: 20,
    });
  });
});

describe('GAP-DEALS-140/180 — updateDeal forwards the funnel fields the domain applies', () => {
  it('sends department_id / tags / probability / expected_close_date', async () => {
    const updateDeal = spy({ id: 'd1' });
    const ctrl = build({ pipe: { updateDeal } });

    await ctrl.updateDeal(req, 'd1', 'p1', {
      name: 'Сделка',
      departmentId: 'dep1',
      tags: ['vip', 'срочно'],
      probability: 70,
      expectedCloseDate: 1_755_300_000,
    });

    expect(updateDeal.calls[0]).toMatchObject({
      project_id: 'p1',
      id: 'd1',
      department_id: 'dep1',
      tags: ['vip', 'срочно'],
      probability: 70,
      expected_close_date: 1_755_300_000,
    });
  });

  it('omits tags when the body does not carry an array (no repeated-field crash)', async () => {
    const updateDeal = spy({ id: 'd1' });
    const ctrl = build({ pipe: { updateDeal } });
    await ctrl.updateDeal(req, 'd1', 'p1', { name: 'x', tags: 'vip' });
    expect(updateDeal.calls[0].tags).toBeUndefined();
  });

  it('returns tags/probability back to the client', async () => {
    const ctrl = build({
      pipe: { updateDeal: () => of({ id: 'd1', tags: ['vip'], probability: 70 }) },
    });
    const res = (await ctrl.updateDeal(req, 'd1', 'p1', {})) as Record<string, unknown>;
    expect(res).toMatchObject({ tags: ['vip'], probability: 70 });
  });

  // В4 (2nd half): product/source/currency/notes were missing from the contract
  // itself, not just from this mapping — the edit form saved everything but them.
  it('sends product_id / source / currency / notes (added to UpdateDealRequest)', async () => {
    const updateDeal = spy({ id: 'd1' });
    const ctrl = build({ pipe: { updateDeal } });

    await ctrl.updateDeal(req, 'd1', 'p1', {
      name: 'Сделка',
      productId: 'pr1',
      source: 'сайт',
      currency: 'EUR',
      notes: 'Перезвонить в среду',
    });

    expect(updateDeal.calls[0]).toMatchObject({
      project_id: 'p1',
      id: 'd1',
      product_id: 'pr1',
      source: 'сайт',
      currency: 'EUR',
      notes: 'Перезвонить в среду',
    });
  });

  it('returns product/source/currency/notes back to the client', async () => {
    const ctrl = build({
      pipe: {
        updateDeal: () =>
          of({
            id: 'd1',
            product_id: 'pr1',
            product_name: 'Тариф',
            source: 'сайт',
            currency: 'EUR',
            notes: 'Перезвонить в среду',
          }),
      },
    });
    const res = (await ctrl.updateDeal(req, 'd1', 'p1', {})) as Record<string, unknown>;
    expect(res).toMatchObject({
      productId: 'pr1',
      productName: 'Тариф',
      source: 'сайт',
      currency: 'EUR',
      notes: 'Перезвонить в среду',
    });
  });

  it('createDeal forwards notes and hands them back (the card renders deal.notes)', async () => {
    const createDeal = spy({ id: 'd1', notes: 'Пришёл с выставки' });
    const ctrl = build({ pipe: { createDeal } });
    const res = (await ctrl.createDeal(
      req,
      { name: 'x', notes: 'Пришёл с выставки' },
      'p1',
    )) as Record<string, unknown>;
    expect(createDeal.calls[0]).toMatchObject({ notes: 'Пришёл с выставки' });
    expect(res.notes).toBe('Пришёл с выставки');
  });
});

describe('GAP-DEALS-200 — GET /v1/pipelines/:id', () => {
  const listReply = {
    list: [
      { id: 'pl1', name: 'Основная', is_default: true, stages: [] },
      {
        id: 'pl2',
        name: 'Партнёры',
        is_default: false,
        stages: [
          { id: 's1', name: 'Новый', color: '#fff', order: 0, kind: 'active', rotting_days: 7 },
        ],
      },
    ],
  };

  it('resolves one pipeline and maps stages to the camelCase the editor reads', async () => {
    const ctrl = build({ pipe: { listPipelines: () => of(listReply) } });
    const res = (await ctrl.getPipeline(req, 'pl2', 'p1')) as Record<string, unknown>;
    expect(res).toMatchObject({ id: 'pl2', name: 'Партнёры', isDefault: false });
    expect(res.stages).toEqual([
      {
        id: 's1',
        name: 'Новый',
        color: '#fff',
        order: 0,
        kind: 'active',
        probability: undefined,
        rottingDays: 7,
      },
    ]);
  });

  it('404s for a pipeline of another project / unknown id', async () => {
    const ctrl = build({ pipe: { listPipelines: () => of(listReply) } });
    await expect(ctrl.getPipeline(req, 'nope', 'p1')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('falls back to the x-project-id header the guards authorized on', async () => {
    const listPipelines = spy(listReply);
    const ctrl = build({ pipe: { listPipelines } });
    const headerReq = { user: { userId: 'u1' }, headers: { 'x-project-id': 'p9' } } as never;
    await ctrl.getPipeline(headerReq, 'pl1', undefined as unknown as string);
    expect(listPipelines.calls[0]).toMatchObject({ project_id: 'p9' });
  });
});

describe('GAP-ORDERS-180/300/150/210 — customFields reach fields_json', () => {
  it('createOrder serialises body.customFields', async () => {
    const createOrder = spy({ id: 'o1' });
    const ctrl = build({ orders: { createOrder } });
    await ctrl.createOrder(
      req,
      { dealId: 'd1', orderTypeId: 't1', customFields: { inn: '7701', qty: 3 } },
      'p1',
    );
    expect(JSON.parse(String(createOrder.calls[0].fields_json))).toEqual({ inn: '7701', qty: 3 });
  });

  it('createOrder still accepts the legacy `fields` spelling', async () => {
    const createOrder = spy({ id: 'o1' });
    const ctrl = build({ orders: { createOrder } });
    await ctrl.createOrder(req, { dealId: 'd1', orderTypeId: 't1', fields: { a: 1 } }, 'p1');
    expect(JSON.parse(String(createOrder.calls[0].fields_json))).toEqual({ a: 1 });
  });

  it('createOrder sends an empty map when neither key is present', async () => {
    const createOrder = spy({ id: 'o1' });
    const ctrl = build({ orders: { createOrder } });
    await ctrl.createOrder(req, { dealId: 'd1', orderTypeId: 't1' }, 'p1');
    expect(createOrder.calls[0].fields_json).toBe('{}');
  });

  it('updateOrder serialises body.customFields (previously never sent at all)', async () => {
    const updateOrder = spy({ id: 'o1' });
    const ctrl = build({ orders: { updateOrder } });
    await ctrl.updateOrder(req, 'o1', 'p1', { customFields: { inn: '7701' } });
    expect(JSON.parse(String(updateOrder.calls[0].fields_json))).toEqual({ inn: '7701' });
  });

  it('updateOrder leaves fields_json undefined when the caller sent no bag', async () => {
    const updateOrder = spy({ id: 'o1' });
    const ctrl = build({ orders: { updateOrder } });
    await ctrl.updateOrder(req, 'o1', 'p1', { assigneeId: 'u2' });
    expect(updateOrder.calls[0].fields_json).toBeUndefined();
  });

  it('returns the stored values back as `fields`', async () => {
    const ctrl = build({
      orders: { updateOrder: () => of({ id: 'o1', fields_json: '{"inn":"7701"}' }) },
    });
    const res = (await ctrl.updateOrder(req, 'o1', 'p1', {})) as Record<string, unknown>;
    expect(res.fields).toEqual({ inn: '7701' });
  });

  it('FR-PRODUCTS-180: createOrder response maps product snapshot fields', async () => {
    const ctrl = build({
      orders: {
        createOrder: () =>
          of({
            id: 'o1',
            product_id: 'pr1',
            product_name: 'Премиум-РКО',
            product_price: 50000,
            product_currency: 'RUB',
            product_unit: 'MONTHLY',
            product_category: 'РКО',
            fields_json: '{}',
          }),
      },
    });
    const res = (await ctrl.createOrder(req, { productId: 'pr1' }, 'p1')) as Record<
      string,
      unknown
    >;
    expect(res).toMatchObject({
      productId: 'pr1',
      productName: 'Премиум-РКО',
      productPrice: 50000,
      productCurrency: 'RUB',
      productUnit: 'MONTHLY',
      productCategory: 'РКО',
    });
  });

  it('FR-ORDERS-200: createOrder forwards notes separately from fields_json', async () => {
    const createOrder = spy({ id: 'o1' });
    const ctrl = build({ orders: { createOrder } });
    await ctrl.createOrder(
      req,
      { dealId: 'd1', orderTypeId: 't1', notes: 'Перезвонить', customFields: { inn: '7701' } },
      'p1',
    );
    expect(createOrder.calls[0].notes).toBe('Перезвонить');
    expect(JSON.parse(String(createOrder.calls[0].fields_json))).toEqual({ inn: '7701' });
  });

  it('FR-ORDERS-200: updateOrder forwards notes and returns them to the client', async () => {
    const updateOrder = spy({ id: 'o1', fields_json: '{}', notes: 'заметка' });
    const ctrl = build({ orders: { updateOrder } });
    const res = (await ctrl.updateOrder(req, 'o1', 'p1', { notes: 'заметка' })) as Record<
      string,
      unknown
    >;
    expect(updateOrder.calls[0].notes).toBe('заметка');
    expect(res.notes).toBe('заметка');
  });
});

describe('GAP-PRODUCTS-160 — prefill travels as a google.protobuf.Struct', () => {
  it('wraps the plain map into Struct on create/update', async () => {
    const createProduct = spy({ id: 'pr1' });
    const updateProduct = spy({ id: 'pr1' });
    const ctrl = build({ product: { createProduct, updateProduct } });

    await ctrl.createProduct(req, { name: 'X', prefill: { inn: '7701', qty: 2, vip: true } }, 'p1');
    expect(createProduct.calls[0].prefill).toEqual({
      fields: { inn: { stringValue: '7701' }, qty: { numberValue: 2 }, vip: { boolValue: true } },
    });

    await ctrl.updateProduct(req, 'pr1', 'p1', { prefill: {} });
    expect(updateProduct.calls[0].prefill).toEqual({ fields: {} });
  });

  it('leaves prefill undefined when the caller omitted it (update keeps PATCH semantics)', async () => {
    const updateProduct = spy({ id: 'pr1' });
    const ctrl = build({ product: { updateProduct } });
    await ctrl.updateProduct(req, 'pr1', 'p1', { name: 'X' });
    expect(updateProduct.calls[0].prefill).toBeUndefined();
  });

  it('unwraps the Struct on the way back to the browser', async () => {
    const ctrl = build({
      product: {
        getProduct: () =>
          of({
            id: 'pr1',
            prefill: {
              fields: {
                inn: { stringValue: '7701' },
                qty: { numberValue: 2 },
                vip: { boolValue: true },
              },
            },
          }),
      },
    });
    const res = (await ctrl.getProduct(req, 'pr1', 'p1')) as Record<string, unknown>;
    expect(res.prefill).toEqual({ inn: '7701', qty: 2, vip: true });
  });

  it('survives an unset Struct as an empty map (never undefined for the FE)', async () => {
    const ctrl = build({ product: { getProduct: () => of({ id: 'pr1' }) } });
    const res = (await ctrl.getProduct(req, 'pr1', 'p1')) as Record<string, unknown>;
    expect(res.prefill).toEqual({});
  });
});

describe('GAP-DOCS-115/185 — the donor PEP verdict is not swallowed', () => {
  const grpcErr = (code: number) => () => throwError(() => ({ code, message: 'denied' }));

  it('generate 403s when the donor denies access to the source record', async () => {
    const ctrl = build({
      pipe: { resolveDocumentVariables: grpcErr(GrpcStatus.PERMISSION_DENIED) },
      documents: { generateDocument: spy({}) },
    });
    await expect(
      ctrl.generateDocument(req, { templateId: 't1', contextType: 'deal', recordId: 'd1' }, 'p1'),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('generate 404s when the source record is gone', async () => {
    const ctrl = build({
      pipe: { resolveDocumentVariables: grpcErr(GrpcStatus.NOT_FOUND) },
      documents: { generateDocument: spy({}) },
    });
    await expect(
      ctrl.generateDocument(req, { templateId: 't1', contextType: 'deal', recordId: 'd1' }, 'p1'),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  // TODO-077 (хвост карточки, FR-DOCS-115): раньше транзиентный отказ резолвера
  // переменных оставался fail-soft и документ выпускался с пустой картой и пустым
  // source_hash. Теперь версия НЕ создаётся — 503, который клиент может повторить.
  it('503s on a transient VARIABLES fault (UNAVAILABLE → no version is created)', async () => {
    const generateDocument = spy({ group: {}, version: {} });
    const ctrl = build({
      pipe: {
        resolveDocumentVariables: grpcErr(GrpcStatus.UNAVAILABLE),
        // The record itself is readable — only the variable resolver is down.
        getDeal: () => of({ id: 'd1', assignee_id: 'u7', department_id: 'dep3' }),
      },
      documents: { generateDocument },
    });
    await expect(
      ctrl.generateDocument(req, { templateId: 't1', contextType: 'deal', recordId: 'd1' }, 'p1'),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(generateDocument.calls).toHaveLength(0);
  });

  // B2: the OWNER snapshot is not fail-soft — a donor that answers with an error
  // rejects the request instead of storing a different owner than it would have
  // stored a minute earlier (crm-bff.document-owner.spec.ts covers 403/404/503).
  it('does NOT fail-soft when the record donor itself is down (no non-deterministic write)', async () => {
    const generateDocument = spy({ group: {}, version: {} });
    const ctrl = build({
      pipe: {
        resolveDocumentVariables: () => of({ values: {}, source_hash: 'h1', empty_required: [] }),
        getDeal: grpcErr(GrpcStatus.UNAVAILABLE),
      },
      documents: { generateDocument },
    });
    await expect(
      ctrl.generateDocument(req, { templateId: 't1', contextType: 'deal', recordId: 'd1' }, 'p1'),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(generateDocument.calls).toHaveLength(0);
  });
});

/**
 * GAP-DOCS-190 as re-scoped by B2: the source record's owner DOES reach documents,
 * but as `context_owner_*` (denormalized reporting data). It must never be sent as
 * `owner_id`, which is the document's ACL owner — writing a foreign owner there
 * locked the author out of his own document (documents/document-owner-acl.spec.ts).
 */
describe('GAP-DOCS-190/B2 — the source record owner travels as a context snapshot', () => {
  it('generate sends context_owner_id/context_owner_department_id resolved from the deal', async () => {
    const generateDocument = spy({ group: {}, version: {} });
    const ctrl = build({
      pipe: {
        resolveDocumentVariables: () => of({ values: {}, source_hash: 'h1', empty_required: [] }),
        getDeal: () => of({ id: 'd1', assignee_id: 'u7', department_id: 'dep3' }),
      },
      documents: { generateDocument },
    });
    await ctrl.generateDocument(
      req,
      { templateId: 't1', contextType: 'deal', recordId: 'd1' },
      'p1',
    );
    expect(generateDocument.calls[0]).toMatchObject({
      context_owner_id: 'u7',
      context_owner_department_id: 'dep3',
      source_hash: 'h1',
    });
    // The ACL owner is the creator, resolved in the domain from x-user-id.
    expect(generateDocument.calls[0]).not.toHaveProperty('owner_id');
  });

  it('generate resolves the company owner + department for a company context', async () => {
    const generateDocument = spy({ group: {}, version: {} });
    const ctrl = build({
      company: {
        resolveDocumentVariables: () => of({ values: {}, source_hash: 'h2', empty_required: [] }),
        getCompany: () => of({ id: 'co1', owner_id: 'u9', department_id: 'dep1' }),
      },
      documents: { generateDocument },
    });
    await ctrl.generateDocument(
      req,
      { templateId: 't1', contextType: 'company', recordId: 'co1' },
      'p1',
    );
    expect(generateDocument.calls[0]).toMatchObject({
      context_owner_id: 'u9',
      context_owner_department_id: 'dep1',
    });
  });

  it('upload sends the record owner snapshot (order: no department in the contract)', async () => {
    const uploadDocument = spy({ group: {}, version: {} });
    const ctrl = build({
      orders: { getOrder: () => of({ id: 'o1', assignee_id: 'u4' }) },
      documents: { uploadDocument },
    });
    await ctrl.uploadDocument(
      req,
      {
        name: 'Акт',
        contextType: 'order',
        recordId: 'o1',
        // X4: a body pointer must name the configured bucket and stay under the
        // authorized project prefix — anything else is refused before the write.
        bucket: 'fairflow-documents',
        objectKey: 'p1/uploads/order/o1/file.pdf',
      },
      'p1',
    );
    expect(uploadDocument.calls[0]).toMatchObject({
      context_owner_id: 'u4',
      context_owner_department_id: '',
    });
    expect(uploadDocument.calls[0]).not.toHaveProperty('owner_id');
  });

  it('upload with contextType=none has no source record to snapshot (uploader owns it)', async () => {
    const uploadDocument = spy({ group: {}, version: {} });
    const ctrl = build({ documents: { uploadDocument } });
    await ctrl.uploadDocument(req, { name: 'Акт', contextType: 'none' }, 'p1');
    expect(uploadDocument.calls[0]).toMatchObject({
      context_owner_id: '',
      context_owner_department_id: '',
    });
  });
});

describe('GAP-DOCS-110/350 — checkDrift hands the domain a real source hash', () => {
  it('re-resolves the donor hash for the group context', async () => {
    const checkDrift = spy({ has_drift: true, changed_keys: ['deal.amount'] });
    const ctrl = build({
      pipe: { resolveDocumentVariables: () => of({ values: {}, source_hash: 'hNEW' }) },
      documents: {
        getDocument: () => of({ group: { context_type: 'deal', context_record_id: 'd1' } }),
        checkDrift,
      },
    });
    const res = (await ctrl.checkDrift(req, 'g1', 'p1')) as Record<string, unknown>;
    expect(checkDrift.calls[0]).toMatchObject({
      project_id: 'p1',
      group_id: 'g1',
      source_hash: 'hNEW',
      source_available: true,
      current_values_json: '{}',
    });
    expect(res).toMatchObject({ hasDrift: true });
  });

  // m8: a document with no source record BY DEFINITION (an uploaded file) is not
  // the same as a donor outage. `source_available: false` made the card claim
  // "источник недоступен" for a document that никогда его и не имел.
  it('reports source_available=true for a context-less (uploaded) document', async () => {
    const checkDrift = spy({ has_drift: false, changed_keys: [] });
    const ctrl = build({
      documents: {
        getDocument: () => of({ group: { context_type: 'none', context_record_id: '' } }),
        checkDrift,
      },
    });
    const res = (await ctrl.checkDrift(req, 'g1', 'p1')) as Record<string, unknown>;
    expect(checkDrift.calls[0]).toMatchObject({ source_hash: '', source_available: true });
    expect(res).toMatchObject({ hasDrift: false, sourceAvailable: true });
  });

  it('keeps source_available=false when the donor itself is unreachable', async () => {
    const checkDrift = spy({ has_drift: false, changed_keys: [] });
    const ctrl = build({
      pipe: {
        resolveDocumentVariables: () => throwError(() => ({ code: GrpcStatus.UNAVAILABLE })),
      },
      documents: {
        getDocument: () => of({ group: { context_type: 'deal', context_record_id: 'd1' } }),
        checkDrift,
      },
    });
    await ctrl.checkDrift(req, 'g1', 'p1');
    expect(checkDrift.calls[0]).toMatchObject({ source_hash: '', source_available: false });
  });

  it('keeps source_available=false for a real context with a broken record link', async () => {
    const checkDrift = spy({ has_drift: false, changed_keys: [] });
    const ctrl = build({
      documents: {
        getDocument: () => of({ group: { context_type: 'deal', context_record_id: '' } }),
        checkDrift,
      },
    });
    await ctrl.checkDrift(req, 'g1', 'p1');
    expect(checkDrift.calls[0]).toMatchObject({ source_available: false });
  });
});

/**
 * m9 — `prefillToStruct` encoded `null` as `{nullValue: 0}`, but neither decoder
 * (this controller's `prefillFromStruct`, nor product/prefill-struct.ts) knows that
 * kind: the key came back MISSING. Round-trip must be symmetric, so a null-valued
 * key is simply not part of the prefill in either direction.
 */
describe('m9 — prefill round-trip is symmetric for null values', () => {
  it('drops a null-valued key instead of encoding an undecodable nullValue', async () => {
    const updateProduct = spy({ id: 'pr1' });
    const ctrl = build({ product: { updateProduct } });
    await ctrl.updateProduct(req, 'pr1', 'p1', { prefill: { inn: '7701', vat: null } });
    expect(updateProduct.calls[0].prefill).toEqual({ fields: { inn: { stringValue: '7701' } } });
  });

  it('what survives encoding is exactly what decoding gives back', async () => {
    const updateProduct = spy({ id: 'pr1' });
    const ctrl = build({ product: { updateProduct } });
    await ctrl.updateProduct(req, 'pr1', 'p1', {
      prefill: { inn: '7701', qty: 2, vip: true, vat: null },
    });
    const encoded = updateProduct.calls[0].prefill;
    const roundTripped = build({
      product: { getProduct: () => of({ id: 'pr1', prefill: encoded }) },
    });
    const res = (await roundTripped.getProduct(req, 'pr1', 'p1')) as Record<string, unknown>;
    expect(res.prefill).toEqual({ inn: '7701', qty: 2, vip: true });
  });
});
