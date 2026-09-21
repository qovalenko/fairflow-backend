/**
 * Волна «Сделки» — слой gateway (BFF).
 *
 * Класс дефектов тот же, что и в прошлой волне: «фронт уже умеет, домен уже умеет,
 * а BFF параметр не объявил — фильтр молча потерялся». Оба теста проверяют ровно то,
 * что уходит в gRPC-запросе к домену, и то, что возвращается наружу.
 *
 *  - TODO-189  GET /v1/deals?deleted=true (корзина сделок) — параметра не было
 *  - TODO-183  GET /v1/activities?dealId=… (виджет активностей карточки сделки)
 */
import { of, throwError } from 'rxjs';
import type { ClientGrpcProxy } from '@nestjs/microservices';
import { CrmBffController } from './crm-bff.controller';

type Svc = Record<string, unknown>;

function stubClient(service: Svc = {}): ClientGrpcProxy {
  return { getService: () => service } as unknown as ClientGrpcProxy;
}

/** Записывает объект запроса, отданный gRPC-заглушке, и отвечает `reply`. */
function spy(reply: unknown = {}) {
  const calls: Record<string, unknown>[] = [];
  const fn = (payload: Record<string, unknown>) => {
    calls.push(payload);
    return of(reply);
  };
  return Object.assign(fn, { calls });
}

/** gRPC-заглушка, которая падает так же, как падает домен: ServiceError с кодом. */
function failing(code: number, details: string) {
  const calls: Record<string, unknown>[] = [];
  const fn = (payload: Record<string, unknown>) => {
    calls.push(payload);
    return throwError(() => Object.assign(new Error(details), { code, details }));
  };
  return Object.assign(fn, { calls });
}

function build(services: {
  pipe?: Svc;
  activity?: Svc;
  contact?: Svc;
  company?: Svc;
  control?: Svc;
}) {
  const ctrl = new CrmBffController(
    stubClient(services.pipe ?? {}),
    stubClient(), // orders
    stubClient(), // product
    stubClient(services.activity ?? {}),
    stubClient(), // documents
    stubClient(), // reports
    stubClient(), // automation
    stubClient(services.control ?? {}),
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

describe('TODO-189 — корзина сделок: ?deleted=true доезжает до pipe', () => {
  const q = (deleted?: string) =>
    [
      req,
      'p1', // projectId
      '0', // pageIndex
      '200', // pageSize
      undefined, // query
      undefined, // pipelineId
      undefined, // stageId
      undefined, // assigneeId
      undefined, // departmentId
      undefined, // status
      undefined, // contactId
      undefined, // companyId
      undefined, // source
      undefined, // amountMin
      undefined, // amountMax
      undefined, // stageDaysMin
      deleted,
    ] as const;

  it('шлёт include_deleted=true, когда DealTrash просит корзину', async () => {
    const listDeals = spy({ list: [], total: 0 });
    const ctrl = build({ pipe: { listDeals } });

    await ctrl.listDeals(...q('true'));

    expect(listDeals.calls[0]).toMatchObject({ project_id: 'p1', include_deleted: true });
  });

  it('обычный список остаётся списком живых сделок (include_deleted=false)', async () => {
    const listDeals = spy({ list: [], total: 0 });
    const ctrl = build({ pipe: { listDeals } });

    await ctrl.listDeals(...q(undefined));
    expect(listDeals.calls[0]).toMatchObject({ include_deleted: false });

    await ctrl.listDeals(...q('false'));
    expect(listDeals.calls[1]).toMatchObject({ include_deleted: false });
  });

  it('обратный путь: deleted_at домена доезжает до FE как deletedAt (колонка «удалена»)', async () => {
    const ctrl = build({
      pipe: {
        listDeals: () =>
          of({
            list: [{ id: 'd1', name: 'Сделка', deleted_at: 1_755_300_000, deleted_by: 'u9' }],
            total: 1,
          }),
      },
    });

    const res = (await ctrl.listDeals(...q('true'))) as {
      list: Record<string, unknown>[];
      total: number;
    };
    expect(res.total).toBe(1);
    expect(res.list[0]).toMatchObject({ id: 'd1', deletedAt: 1_755_300_000 });
  });
});

describe('FR-SEARCH-390 — серверные фильтры списка сделок', () => {
  it('прокидывает minDaysOnStage и withoutAssignee в pipe', async () => {
    const listDeals = spy({ list: [], total: 0 });
    const ctrl = build({ pipe: { listDeals } });
    await ctrl.listDeals(
      req,
      'p1',
      '0',
      '25',
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined, // stageDaysMin
      undefined, // deleted
      '14',
      'true',
    );
    expect(listDeals.calls[0]).toMatchObject({
      min_days_on_stage: 14,
      without_assignee: true,
    });
  });
});

describe('TODO-183 — виджет активностей карточки сделки фильтруется по сделке', () => {
  const q = (opts: { dealId?: string; linkEntityType?: string; linkEntityId?: string } = {}) =>
    [
      req,
      'p1', // projectId
      '0', // pageIndex
      '25', // pageSize
      undefined, // query
      undefined, // type
      undefined, // types
      undefined, // status
      undefined, // overdueOnly
      undefined, // assigneeId
      opts.linkEntityType, // linkEntityType
      opts.linkEntityId, // linkEntityId
      undefined, // dateFrom
      undefined, // dateTo
      undefined, // includeDeleted
      undefined, // sortField
      undefined, // sortOrder
      undefined, // state
      opts.dealId,
    ] as const;

  it('dealId разворачивается в link_entity_type=deal + link_entity_id', async () => {
    const listActivities = spy({ list: [], total: 0 });
    const ctrl = build({ activity: { listActivities } });

    await ctrl.listActivities(...q({ dealId: 'd1' }));

    expect(listActivities.calls[0]).toMatchObject({
      project_id: 'p1',
      link_entity_type: 'deal',
      link_entity_id: 'd1',
    });
  });

  it('явные linkEntityType/linkEntityId приоритетнее алиаса', async () => {
    const listActivities = spy({ list: [], total: 0 });
    const ctrl = build({ activity: { listActivities } });

    await ctrl.listActivities(
      ...q({ dealId: 'd1', linkEntityType: 'contact', linkEntityId: 'c7' }),
    );

    expect(listActivities.calls[0]).toMatchObject({
      link_entity_type: 'contact',
      link_entity_id: 'c7',
    });
  });

  it('без dealId и без link-параметров фильтр по связи не навязывается', async () => {
    const listActivities = spy({ list: [], total: 0 });
    const ctrl = build({ activity: { listActivities } });

    await ctrl.listActivities(...q());

    expect(listActivities.calls[0]).toMatchObject({ link_entity_type: '', link_entity_id: '' });
  });
});

describe('FR-SEARCH-410 — фильтр «без ответственного» в списке активностей', () => {
  it('прокидывает without_assignee в activity.listActivities', async () => {
    const listActivities = spy({ list: [], total: 0 });
    const ctrl = build({ activity: { listActivities } });
    await ctrl.listActivities(
      req,
      'p1',
      '0',
      '25',
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      'true',
    );
    expect(listActivities.calls[0]).toMatchObject({ without_assignee: true });
  });
});

// ---------------------------------------------------------------------------
// Доработка ревью (последствие TODO-185/TODO-178): резолв донора связи —
// fail-closed. Раньше ошибка contact.GetContact глушилась (`catch { snapshot =
// undefined }`), и связь ставилась с ПУСТЫМ снимком. Пока снимок не ездил по
// проводу, это было безобидно; теперь drift сравнивает пустой снимок с живым
// контактом и отдаёт наружу его реальные имя/телефон/почту (getDealDrift →
// current_value, accept-drift → contactSnapshot). Значит: не смог прочитать
// донора — не связываем.
// ---------------------------------------------------------------------------
describe('link/qualify: донор связи резолвится fail-closed', () => {
  const CONTACT = {
    id: 'c-2',
    last_name: 'Петров',
    first_name: 'Иван',
    middle_name: '',
    phone: '+79990000000',
    email: 'i@p.ru',
  };

  it('link-contact: невидимый/отсутствующий контакт не привязывается', async () => {
    const getContact = failing(5 /* NOT_FOUND */, 'Contact not found');
    const linkContact = spy({ id: 'd1' });
    const ctrl = build({ pipe: { linkContact }, contact: { getContact } });

    await expect(
      ctrl.linkContact(req, 'd1', 'p1', { contactId: 'c-foreign' }),
    ).rejects.toMatchObject({ code: 5 });

    expect(getContact.calls[0]).toMatchObject({ project_id: 'p1', id: 'c-foreign' });
    expect(linkContact.calls).toHaveLength(0); // связи не случилось
  });

  it('link-contact: видимый контакт привязывается вместе со снимком', async () => {
    const getContact = spy(CONTACT);
    const linkContact = spy({ id: 'd1' });
    const ctrl = build({ pipe: { linkContact }, contact: { getContact } });

    await ctrl.linkContact(req, 'd1', 'p1', { contactId: 'c-2' });

    expect(linkContact.calls[0]).toMatchObject({
      project_id: 'p1',
      id: 'd1',
      contact_id: 'c-2',
      snapshot: { name: 'Петров Иван', phone: '+79990000000', email: 'i@p.ru' },
    });
  });

  it('link-company: нечитаемая компания не привязывается', async () => {
    const getCompany = failing(7 /* PERMISSION_DENIED */, 'denied');
    const linkCompany = spy({ id: 'd1' });
    const ctrl = build({ pipe: { linkCompany }, company: { getCompany } });

    await expect(
      ctrl.linkCompany(req, 'd1', 'p1', { companyId: 'co-foreign' }),
    ).rejects.toMatchObject({ code: 7 });
    expect(linkCompany.calls).toHaveLength(0);
  });

  it('qualify по выбранному дублю: нечитаемый контакт не привязывается', async () => {
    const getContact = failing(5, 'Contact not found');
    const linkContact = spy({ id: 'd1' });
    const ctrl = build({
      pipe: { getDeal: () => of({ id: 'd1', light_name: 'Иван Петров' }), linkContact },
      contact: { getContact },
    });

    await expect(
      ctrl.qualifyDeal(req, 'd1', 'p1', { target: 'contact', contactId: 'c-foreign' }),
    ).rejects.toMatchObject({ code: 5 });
    expect(linkContact.calls).toHaveLength(0);
  });

  it('FR-DEALS-060: единственный живой кандидат авто-привязывается без развилки', async () => {
    const findDuplicates = spy({
      candidates: [
        {
          contact_id: 'c-live',
          display_name: 'Иван',
          matched_on: 'phone',
          masked_value: '+7***',
          deleted: false,
        },
      ],
    });
    const getContact = spy({
      id: 'c-live',
      first_name: 'Иван',
      last_name: 'Петров',
      phone: '+79990000000',
      email: 'i@p.ru',
    });
    const linkContact = spy({ id: 'd1' });
    const ctrl = build({
      pipe: {
        getDeal: () => of({ id: 'd1', light_name: 'Иван', light_phone: '+79990000000' }),
        linkContact,
      },
      contact: { findDuplicates, getContact, createContact: spy({ id: 'must-not-create' }) },
    });

    const res = (await ctrl.qualifyDeal(req, 'd1', 'p1', { target: 'contact' })) as {
      status: string;
      contactId: string;
    };

    expect(res).toMatchObject({ status: 'qualified', contactId: 'c-live' });
    expect(linkContact.calls[0]).toMatchObject({ contact_id: 'c-live' });
  });

  it('FR-DEALS-060: единственный кандидат из корзины не авто-линкуется', async () => {
    const findDuplicates = spy({
      candidates: [
        {
          contact_id: 'c-trash',
          display_name: 'Иван',
          matched_on: 'phone',
          masked_value: '+7***',
          deleted: true,
        },
      ],
    });
    const linkContact = spy({ id: 'd1' });
    const ctrl = build({
      pipe: {
        getDeal: () => of({ id: 'd1', light_phone: '+79990000000' }),
        linkContact,
      },
      contact: { findDuplicates },
    });

    const res = (await ctrl.qualifyDeal(req, 'd1', 'p1', { target: 'contact' })) as {
      status: string;
      candidates: Array<{ deleted?: boolean }>;
    };

    expect(res.status).toBe('duplicates');
    expect(res.candidates[0].deleted).toBe(true);
    expect(linkContact.calls).toHaveLength(0);
  });

  it('qualify с созданием контакта: снимок берётся из ответа createContact, без read-back', async () => {
    const getContact = spy(CONTACT); // не должен вызываться
    const createContact = spy({ ...CONTACT, id: 'c-new' });
    const linkContact = spy({ id: 'd1' });
    const ctrl = build({
      pipe: {
        getDeal: () =>
          of({
            id: 'd1',
            light_name: 'Петров Иван',
            light_phone: '+79990000000',
            light_email: 'i@p.ru',
            assignee_id: 'u-owner',
          }),
        linkContact,
      },
      contact: { getContact, createContact, findDuplicates: () => of({ candidates: [] }) },
    });

    const res = (await ctrl.qualifyDeal(req, 'd1', 'p1', {
      target: 'contact',
      createNew: true,
    })) as { status: string; contactId: string };

    expect(res).toMatchObject({ status: 'qualified', contactId: 'c-new' });
    // read-back невидимого для вызывающего контакта отменил бы qualify уже ПОСЛЕ
    // создания — остался бы контакт-сирота. Снимок берём из ответа на создание.
    expect(getContact.calls).toHaveLength(0);
    expect(linkContact.calls[0]).toMatchObject({
      contact_id: 'c-new',
      snapshot: { name: 'Петров Иван', phone: '+79990000000', email: 'i@p.ru' },
    });
  });
});

// Тот же гейт на «широких» путях записи: contactId/companyId в теле create/update —
// это тоже привязка, иначе POST /deals {contactId: <чужой>} остаётся второй дверью
// к той же утечке PII через drift карточки сделки.
describe('create/update сделки: донор связи в теле проходит гейт чтения', () => {
  it('createDeal с невидимым contactId не создаёт сделку', async () => {
    const getContact = failing(5, 'Contact not found');
    const createDeal = spy({ id: 'd1' });
    const ctrl = build({ pipe: { createDeal }, contact: { getContact } });

    await expect(
      ctrl.createDeal(req, { name: 'Сделка', contactId: 'c-foreign' }, 'p1'),
    ).rejects.toMatchObject({ code: 5 });
    expect(createDeal.calls).toHaveLength(0);
  });

  it('updateDeal с невидимой companyId не сохраняет сделку', async () => {
    const getCompany = failing(5, 'Company not found');
    const updateDeal = spy({ id: 'd1' });
    const ctrl = build({ pipe: { updateDeal }, company: { getCompany } });

    await expect(
      ctrl.updateDeal(req, 'd1', 'p1', { companyId: 'co-foreign' }),
    ).rejects.toMatchObject({ code: 5 });
    expect(updateDeal.calls).toHaveLength(0);
  });

  it('отвязка (пустое значение) донора не требует — TODO-385 clearing жив', async () => {
    const getContact = failing(5, 'must not be called');
    const updateDeal = spy({ id: 'd1' });
    const ctrl = build({ pipe: { updateDeal }, contact: { getContact } });

    await ctrl.updateDeal(req, 'd1', 'p1', { contactId: '', companyId: '' });

    expect(getContact.calls).toHaveLength(0);
    expect(updateDeal.calls[0]).toMatchObject({ contact_id: '', company_id: '' });
  });

  it('видимый контакт в теле create пропускается дальше в домен', async () => {
    const getContact = spy({ id: 'c1', first_name: 'Иван', last_name: 'Петров' });
    const createDeal = spy({ id: 'd1' });
    const ctrl = build({ pipe: { createDeal }, contact: { getContact } });

    await ctrl.createDeal(req, { name: 'Сделка', contactId: 'c1' }, 'p1');

    expect(createDeal.calls[0]).toMatchObject({ project_id: 'p1', contact_id: 'c1' });
  });
});

describe('SCR-DEALS-DISABLE-CASCADE-DIALOG — preview open count + cascade dependents', () => {
  it('returns open deal total and enabled dependents of deals', async () => {
    const listDeals = spy({ total: 12 });
    const getProject = spy({
      effective_modules: ['deals', 'orders', 'activities'],
      module_configs: [
        { module_id: 'deals', enabled: true, installed: true },
        { module_id: 'orders', enabled: true, installed: true },
        { module_id: 'activities', enabled: true, installed: true },
      ],
    });
    const ctrl = build({
      pipe: { listDeals },
      control: { getProject },
    });

    const res = (await ctrl.dealsDisableCascadePreview(req, 'p1')) as {
      openDealCount: number | null;
      cascadeModules: Array<{ id: string; name: string }>;
    };

    expect(listDeals.calls[0]).toMatchObject({
      project_id: 'p1',
      status: 'open',
      page_index: 0,
      page_size: 1,
      include_deleted: false,
    });
    expect(res.openDealCount).toBe(12);
    expect(res.cascadeModules.map((m) => m.id)).toEqual(
      expect.arrayContaining(['orders', 'activities']),
    );
  });

  it('degrades openDealCount to null when listDeals fails (ST-6)', async () => {
    const listDeals = failing(14, 'pipe down');
    const getProject = spy({ effective_modules: ['deals', 'orders'] });
    const ctrl = build({ pipe: { listDeals }, control: { getProject } });

    const res = (await ctrl.dealsDisableCascadePreview(req, 'p1')) as {
      openDealCount: number | null;
      cascadeModules: Array<{ id: string }>;
    };

    expect(res.openDealCount).toBeNull();
    expect(res.cascadeModules.length).toBeGreaterThan(0);
  });
});
