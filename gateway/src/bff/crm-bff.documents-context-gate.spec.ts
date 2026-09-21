/**
 * TODO-098 + TODO-077 — контекст документа и его модуль-донор.
 *
 * TODO-098 (вторая половина карточки): жёсткое ребро documents → orders снято в
 * MODULE_REGISTRY, но зависимость должна остаться МЯГКОЙ и вычисляемой из
 * DOCUMENT_CONTEXT_TO_MODULE: контекст, чей модуль-донор выключен в проекте, не
 * принимается ни при создании шаблона, ни при генерации. Чтение уже выпущенных
 * документов при этом не блокируется.
 *
 * TODO-077 (хвост карточки, FR-DOCS-115): отказ донора переменных больше не
 * подменяется пустой картой. 403/404 — вердикт PEP (закрыто раньше), всё
 * остальное (UNAVAILABLE/DEADLINE_EXCEEDED/UNIMPLEMENTED) — 503, версия не
 * создаётся. Пустая карта остаётся только там, где донора нет по определению.
 */
import { of, throwError } from 'rxjs';
import { ConflictException, ServiceUnavailableException } from '@nestjs/common';
import { status as GrpcStatus } from '@grpc/grpc-js';
import type { ClientGrpcProxy } from '@nestjs/microservices';
import { CrmBffController } from './crm-bff.controller';

type Svc = Record<string, unknown>;

function stubClient(service: Svc = {}): ClientGrpcProxy {
  return { getService: () => service } as unknown as ClientGrpcProxy;
}

function spy(reply: unknown = {}) {
  const calls: Record<string, unknown>[] = [];
  const fn = (payload: Record<string, unknown>) => {
    calls.push(payload);
    return of(reply);
  };
  return Object.assign(fn, { calls });
}

const DOCUMENTS_BUCKET = 'fairflow-documents';

const grpcErr = (code: number) => () => throwError(() => ({ code, message: 'x' }));

function build(services: { pipe?: Svc; orders?: Svc; documents?: Svc; contact?: Svc } = {}) {
  const ctrl = new CrmBffController(
    stubClient(services.pipe ?? {}),
    stubClient(services.orders ?? {}),
    stubClient(), // product
    stubClient(), // activity
    stubClient(services.documents ?? {}),
    stubClient(), // reports
    stubClient(), // automation
    stubClient({ getProject: () => of({ name: 'P' }) }), // control (project.name global)
    stubClient(services.contact ?? {}),
    stubClient(), // company
    { build: () => ({}) } as never,
    {} as never, // docStorage (JSON-путь его не трогает)
    { s3DocumentsBucket: 'fairflow-documents' } as never, // config (X4)
    { resolveNames: async () => new Map() } as never,
    {} as never, // reportRunNames
  );
  ctrl.onModuleInit();
  return ctrl;
}

/** Запрос с набором модулей, который положил бы GatewayModuleGuard. */
const reqWith = (modules?: string[]) =>
  ({
    user: { userId: 'u1' },
    headers: { 'x-project-id': 'p1' },
    __projectRole: 'manager',
    ...(modules ? { __enabledModules: modules } : {}),
  }) as never;

describe('TODO-098 — контекст выключенного модуля-донора не принимается', () => {
  it('generate: contextType=order при выключенном orders → 409 CONTEXT_UNAVAILABLE, донор не зовётся', async () => {
    const requestOrderDocument = spy({ values: {}, source_hash: 'h' });
    const generateDocument = spy({ group: {}, version: {} });
    const ctrl = build({
      orders: { requestOrderDocument, getOrder: () => of({ id: 'o1' }) },
      documents: { generateDocument },
    });

    await expect(
      ctrl.generateDocument(
        reqWith(['documents', 'deals', 'contacts']),
        { templateId: 't1', contextType: 'order', recordId: 'o1' },
        'p1',
      ),
    ).rejects.toMatchObject({ response: { code: 'CONTEXT_UNAVAILABLE', module: 'orders' } });
    expect(requestOrderDocument.calls).toHaveLength(0);
    expect(generateDocument.calls).toHaveLength(0);
  });

  it('generate: тот же контекст при включённом orders проходит насквозь', async () => {
    const generateDocument = spy({ group: { group_id: 'g1' }, version: { version_id: 'v1' } });
    const ctrl = build({
      orders: {
        requestOrderDocument: () => of({ values: { 'order.number': '7' }, source_hash: 'h' }),
        getOrder: () => of({ id: 'o1', assignee_id: 'u9' }),
      },
      documents: { generateDocument },
    });

    await ctrl.generateDocument(
      reqWith(['documents', 'orders']),
      { templateId: 't1', contextType: 'order', recordId: 'o1' },
      'p1',
    );

    expect(generateDocument.calls).toHaveLength(1);
    expect(generateDocument.calls[0]).toMatchObject({ context_type: 'order', source_hash: 'h' });
  });

  it('generate: contextType=deal при выключенном deals → 409 (гейт вычисляемый, не про orders)', async () => {
    const generateDocument = spy({ group: {}, version: {} });
    const ctrl = build({
      pipe: { resolveDocumentVariables: spy({ values: {} }) },
      documents: { generateDocument },
    });

    await expect(
      ctrl.generateDocument(
        reqWith(['documents', 'orders']),
        { templateId: 't1', contextType: 'deal', recordId: 'd1' },
        'p1',
      ),
    ).rejects.toMatchObject({ response: { code: 'CONTEXT_UNAVAILABLE', module: 'deals' } });
    expect(generateDocument.calls).toHaveLength(0);
  });

  it('createTemplate: шаблон нельзя привязать к контексту выключенного модуля', async () => {
    const createTemplate = spy({ id: 't1' });
    const ctrl = build({ documents: { createTemplate } });

    await expect(
      ctrl.createTemplate(
        reqWith(['documents', 'deals']),
        {
          name: 'Акт',
          contextType: 'order',
          bucket: DOCUMENTS_BUCKET,
          objectKey: 'p1/templates/act.docx',
        },
        'p1',
      ),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(createTemplate.calls).toHaveLength(0);
  });

  it('createTemplate: контекст включённого модуля создаётся как раньше', async () => {
    const createTemplate = spy({ id: 't1' });
    const ctrl = build({ documents: { createTemplate } });

    await ctrl.createTemplate(
      reqWith(['documents', 'orders']),
      {
        name: 'Акт',
        contextType: 'order',
        bucket: DOCUMENTS_BUCKET,
        objectKey: 'p1/templates/act.docx',
      },
      'p1',
    );

    expect(createTemplate.calls).toHaveLength(1);
    expect(createTemplate.calls[0]).toMatchObject({ context_type: 'order', project_id: 'p1' });
  });

  it('contextType=none донора не имеет — гейт его не трогает (FR-MDOC-17)', async () => {
    const generateDocument = spy({ group: {}, version: {} });
    const ctrl = build({ documents: { generateDocument } });

    await ctrl.generateDocument(
      reqWith(['documents']),
      { templateId: 't1', contextType: 'none', recordId: '' },
      'p1',
    );

    expect(generateDocument.calls).toHaveLength(1);
  });

  it('regenerate: contextType=order при выключенном orders → 409, regenerate не зовётся', async () => {
    const regenerateDocument = spy({ group: {}, version: {} });
    const ctrl = build({
      orders: { resolveDocumentVariables: spy({ values: {} }) },
      documents: {
        getDocument: () => of({ group: { context_type: 'order', context_record_id: 'o1' } }),
        regenerateDocument,
      },
    });

    await expect(
      ctrl.regenerateDocument(reqWith(['documents', 'deals']), 'g1', {}, 'p1'),
    ).rejects.toMatchObject({ response: { code: 'CONTEXT_UNAVAILABLE', module: 'orders' } });
    expect(regenerateDocument.calls).toHaveLength(0);
  });

  it('чтение выпущенных документов не блокируется выключенным донором (карточка требует явно)', async () => {
    const listDocuments = spy({ list: [] });
    const getDocument = spy({ group: { group_id: 'g1', context_type: 'order' } });
    const ctrl = build({ documents: { listDocuments, getDocument } });

    await ctrl.listDocuments(reqWith(['documents']), 'p1', 'order', 'o1');
    await ctrl.getDocument(reqWith(['documents']), 'g1', 'p1');

    expect(listDocuments.calls).toHaveLength(1);
    expect(getDocument.calls).toHaveLength(1);
  });
});

describe('TODO-077 — отказ донора переменных не подменяется пустой картой', () => {
  it('DEADLINE_EXCEEDED донора → 503, версия не создаётся', async () => {
    const generateDocument = spy({ group: {}, version: {} });
    const ctrl = build({
      orders: {
        requestOrderDocument: grpcErr(GrpcStatus.DEADLINE_EXCEEDED),
        getOrder: () => of({ id: 'o1', assignee_id: 'u9' }),
      },
      documents: { generateDocument },
    });

    await expect(
      ctrl.generateDocument(
        reqWith(['documents', 'orders']),
        { templateId: 't1', contextType: 'order', recordId: 'o1' },
        'p1',
      ),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(generateDocument.calls).toHaveLength(0);
  });

  it('донор без RPC ResolveDocumentVariables → 503, а не документ с пустыми полями', async () => {
    const generateDocument = spy({ group: {}, version: {} });
    const ctrl = build({
      orders: { getOrder: () => of({ id: 'o1', assignee_id: 'u9' }) }, // RPC не реализован
      documents: { generateDocument },
    });

    await expect(
      ctrl.generateDocument(
        reqWith(['documents', 'orders']),
        { templateId: 't1', contextType: 'order', recordId: 'o1' },
        'p1',
      ),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(generateDocument.calls).toHaveLength(0);
  });

  it('regenerate по недоступному донору тоже 503 (новая версия не пишется)', async () => {
    const regenerateDocument = spy({ group: {}, version: {} });
    const ctrl = build({
      orders: { requestOrderDocument: grpcErr(GrpcStatus.UNAVAILABLE) },
      documents: {
        getDocument: () =>
          of({
            group: { context_type: 'order', context_record_id: 'o1', template_id: 't1' },
          }),
        regenerateDocument,
      },
    });

    await expect(
      ctrl.regenerateDocument(reqWith(['documents', 'orders']), 'g1', {}, 'p1'),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(regenerateDocument.calls).toHaveLength(0);
  });

  it('regenerate order: drift-gate 409 не подменяется пустой картой (FR-ORDERS-255)', async () => {
    const regenerateDocument = spy({ group: {}, version: {} });
    const requestOrderDocument = () =>
      throwError(() => ({
        code: GrpcStatus.FAILED_PRECONDITION,
        message: JSON.stringify({ code: 'DRIFT_NOT_ACCEPTED', orderId: 'o1' }),
      }));
    const ctrl = build({
      orders: { requestOrderDocument },
      documents: {
        getDocument: () =>
          of({
            group: { context_type: 'order', context_record_id: 'o1', template_id: 't1' },
          }),
        regenerateDocument,
      },
    });

    await expect(
      ctrl.regenerateDocument(reqWith(['documents', 'orders']), 'g1', {}, 'p1'),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(regenerateDocument.calls).toHaveLength(0);
  });

  it('checkDrift остаётся мягким: недоступный донор → source_available=false, а не 503', async () => {
    const checkDrift = spy({ has_drift: false, changed_keys: [] });
    const ctrl = build({
      orders: { resolveDocumentVariables: grpcErr(GrpcStatus.UNAVAILABLE) },
      documents: {
        getDocument: () => of({ group: { context_type: 'order', context_record_id: 'o1' } }),
        checkDrift,
      },
    });

    await ctrl.checkDrift(reqWith(['documents', 'orders']), 'g1', 'p1');

    expect(checkDrift.calls[0]).toMatchObject({ source_hash: '', source_available: false });
  });
});
