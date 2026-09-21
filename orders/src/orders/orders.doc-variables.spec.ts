import { ObjectId } from 'mongodb';
import type { VisibilityScope } from '@fairflow/shared';
import { OrdersService } from './orders.service';
import { noopSpecValidator } from './test-helpers';
import type { SourceRead } from './order-drift';

/**
 * TODO-207 (tail of FR-ORDERS-460) — `deal.name` / `contact.name` / `company.name`
 * of the DOCUMENT variable map.
 *
 * The BFF join (`fillOrderNames`) covers the list/kanban/card/CSV responses, but
 * `ResolveDocumentVariables` is proxied verbatim to documents — so the names have
 * to be resolved here, inside the same call that computes `source_hash`.
 *
 * Covered: the pinned snapshot is used first (no IO), the deal (which has no
 * snapshot) comes from a live read, an already denormalized name is never
 * overwritten and costs no read, the caller's visibility scope is what the live
 * read carries, and a dead donor degrades to an empty name instead of an error.
 */
type AnyRec = Record<string, unknown>;

const SCOPE = {
  mode: 'own',
  level: 'own',
  selfId: 'u7',
  ownerIds: ['u7'],
  sharedRecordIds: [],
} as unknown as VisibilityScope;

function makeService(opts: {
  doc: AnyRec;
  contactRead?: SourceRead | Error;
  companyRead?: SourceRead | Error;
  dealName?: string | Error;
}) {
  const reads: Array<{ kind: string; id: string; scope?: VisibilityScope }> = [];

  const mongo = {
    orders: () => ({
      findOne: async () => opts.doc,
    }),
    orderTypes: () => ({
      findOne: async () => ({
        id: 't1',
        name: 'Продажа курса',
        stages: [{ id: 'os1', name: 'Новая', order: 0 }],
      }),
    }),
  } as unknown as ConstructorParameters<typeof OrdersService>[0];

  const outbox = {} as unknown as ConstructorParameters<typeof OrdersService>[1];

  const sourceReader = {
    readContact: async (_p: string, id: string, scope?: VisibilityScope): Promise<SourceRead> => {
      reads.push({ kind: 'contact', id, scope });
      if (opts.contactRead instanceof Error) throw opts.contactRead;
      return opts.contactRead ?? { state: 'unknown', fields: {} };
    },
    readCompany: async (_p: string, id: string, scope?: VisibilityScope): Promise<SourceRead> => {
      reads.push({ kind: 'company', id, scope });
      if (opts.companyRead instanceof Error) throw opts.companyRead;
      return opts.companyRead ?? { state: 'unknown', fields: {} };
    },
    readDealName: async (_p: string, id: string, scope?: VisibilityScope): Promise<string> => {
      reads.push({ kind: 'deal', id, scope });
      if (opts.dealName instanceof Error) throw opts.dealName;
      return opts.dealName ?? '';
    },
  } as unknown as ConstructorParameters<typeof OrdersService>[2];

  return { service: new OrdersService(mongo, outbox, sourceReader, noopSpecValidator), reads };
}

const order = (over: AnyRec = {}): AnyRec => ({
  _id: new ObjectId(),
  projectId: 'p1',
  typeId: 't1',
  orderTypeVersion: 1,
  stageId: 'os1',
  number: 'ORD-00001',
  status: 'ACTIVE',
  assigneeId: 'u7',
  dealId: 'd1',
  contactId: 'c1',
  companyId: 'co1',
  fieldsJson: '{"inn":"7701"}',
  snapshot: {
    contact: { name: 'Иван Иванович Иванов', phone: '+7', email: 'a@x' },
    company: { name: 'ООО Ромашка', inn: '7701', kpp: '' },
  },
  createdAt: 1,
  updatedAt: 1,
  ...over,
});

describe('OrdersService.resolveDocumentVariables — имена связанных сущностей (TODO-207)', () => {
  it('берёт contact.name/company.name из закреплённого снапшота без обращений к донорам', async () => {
    const { service, reads } = makeService({ doc: order({ dealId: '' }) });

    const res = await service.resolveDocumentVariables('p1', String(order()._id), SCOPE);

    expect(res.values['contact.name']).toBe('Иван Иванович Иванов');
    expect(res.values['company.name']).toBe('ООО Ромашка');
    // Снапшот закрыл обе переменные, сделки нет — читать нечего.
    expect(reads).toEqual([]);
  });

  it('резолвит deal.name живым чтением pipe (снапшота сделки в продаже нет)', async () => {
    const { service, reads } = makeService({ doc: order(), dealName: 'Сделка №5' });

    const res = await service.resolveDocumentVariables('p1', String(order()._id), SCOPE);

    expect(res.values['deal.name']).toBe('Сделка №5');
    expect(reads).toEqual([{ kind: 'deal', id: 'd1', scope: SCOPE }]);
  });

  it('дочитывает контакт/компанию, если снапшот пустой (продажа создана при недоступном доноре)', async () => {
    const { service, reads } = makeService({
      doc: order({ dealId: '', snapshot: { contact: {}, company: {} } }),
      contactRead: { state: 'present', fields: { name: 'Пётр Петров', phone: '', email: '' } },
      companyRead: { state: 'present', fields: { name: 'АО Заря', inn: '', kpp: '' } },
    });

    const res = await service.resolveDocumentVariables('p1', String(order()._id), SCOPE);

    expect(res.values['contact.name']).toBe('Пётр Петров');
    expect(res.values['company.name']).toBe('АО Заря');
    // Чтение идёт под scope вызывающего, а не под сервисным mode:'all'.
    expect(reads.map((r) => r.scope)).toEqual([SCOPE, SCOPE]);
  });

  it('не перетирает уже денормализованное имя и не тратит на него вызов', async () => {
    const { service, reads } = makeService({
      doc: order({ dealName: 'Сохранённое имя', snapshot: { contact: {}, company: {} } }),
      contactRead: { state: 'present', fields: { name: 'Пётр Петров', phone: '', email: '' } },
      companyRead: { state: 'present', fields: { name: 'АО Заря', inn: '', kpp: '' } },
      dealName: 'Из pipe',
    });

    const res = await service.resolveDocumentVariables('p1', String(order()._id), SCOPE);

    expect(res.values['deal.name']).toBe('Сохранённое имя');
    expect(reads.map((r) => r.kind).sort()).toEqual(['company', 'contact']);
  });

  it('fail-soft: недоступный/удалённый донор оставляет имя пустым, но не роняет генерацию', async () => {
    const { service } = makeService({
      doc: order({ snapshot: { contact: {}, company: {} } }),
      contactRead: { state: 'unknown', fields: {} },
      companyRead: { state: 'deleted', fields: {} },
      dealName: '',
    });

    const res = await service.resolveDocumentVariables('p1', String(order()._id), SCOPE);

    expect(res.values['deal.name']).toBe('');
    expect(res.values['contact.name']).toBe('');
    expect(res.values['company.name']).toBe('');
    // Обязательная переменная продажи по-прежнему заполнена — документ генерируется.
    expect(res.values['order.number']).toBe('ORD-00001');
    expect(res.empty_required).toEqual([]);
  });

  it('source_hash покрывает имена: переименование источника меняет хеш (иначе drift документа слеп)', async () => {
    const id = String(order()._id);
    const before = await makeService({
      doc: order({ dealId: '', snapshot: { contact: { name: 'Иван Иванов' }, company: {} } }),
    }).service.resolveDocumentVariables('p1', id, SCOPE);
    const after = await makeService({
      doc: order({ dealId: '', snapshot: { contact: { name: 'Иван Петров' }, company: {} } }),
    }).service.resolveDocumentVariables('p1', id, SCOPE);

    expect(before.values['contact.name']).not.toBe(after.values['contact.name']);
    expect(before.source_hash).not.toBe(after.source_hash);
  });

  it('игнорирует битый fields_json и не роняет резолв переменных', async () => {
    const { service } = makeService({ doc: order({ fieldsJson: '{not-json' }) });
    const res = await service.resolveDocumentVariables('p1', String(order()._id), SCOPE);
    expect(res.values['order.number']).toBe('ORD-00001');
    expect(Object.keys(res.values).some((k) => k.startsWith('order.field.'))).toBe(false);
  });
});
