/**
 * FR-COMPANIES-375 — карточка компании отдаёт данные ЧУЖИХ модулей.
 *
 * До правки `/companies/:id/card` резолвил видимость один раз (субъект маршрута
 * `companies`) и передавал ту же метадату донорам contact/pipe/orders/activity:
 * пользователь с широкой видимостью по компаниям и суженной по сделкам получал
 * через карточку то, чего прямой список `/deals` ему не отдаёт. Плюс контакты
 * тянулись одним запросом `page_size: 1000`, который домен режет до 100
 * (`contacts.service.ts` MAX_PAGE_SIZE) — начиная со 101-го контакта проекта
 * связи молча терялись.
 *
 * Здесь проверяется потребитель: карточка обязана брать метадату КАЖДОГО донора
 * из `req.__donorAccess` (его резолвит ProjectAccessGuard, см.
 * project-access.donor-subjects.spec.ts) и мести контакты страницами.
 */
import { of } from 'rxjs';
import type { ClientGrpcProxy } from '@nestjs/microservices';
import { V1DataBffController } from './v1-data-bff.controller';
import { REQUIRED_DONOR_SUBJECTS_KEY } from '../guards/require-donor-subjects.decorator';
import { parseVisibilityScope } from '@fairflow/shared';

function stubClient(service: Record<string, unknown> = {}): ClientGrpcProxy {
  return { getService: () => service } as unknown as ClientGrpcProxy;
}

type Clients = {
  company?: Record<string, unknown>;
  contact?: Record<string, unknown>;
  pipe?: Record<string, unknown>;
  orders?: Record<string, unknown>;
  activity?: Record<string, unknown>;
  documents?: Record<string, unknown>;
  audit?: Record<string, unknown>;
};

/** Метадата = отпечаток того, чей скоуп реально уехал в домен. */
const outboundMeta = {
  build: (r: { __visibilityScope?: string; __accessPredicate?: string }) => ({
    scope: r.__visibilityScope ?? null,
    predicate: r.__accessPredicate ?? null,
  }),
} as never;

function build(c: Clients = {}) {
  const ctrl = new V1DataBffController(
    stubClient(),
    stubClient(c.contact ?? {}),
    stubClient(c.company ?? {}),
    stubClient(),
    stubClient(),
    stubClient(c.audit ?? { listEvents: () => of({ list: [] }) }),
    stubClient(c.pipe ?? {}),
    stubClient(c.orders ?? {}),
    stubClient(c.activity ?? {}),
    stubClient(c.documents ?? {}),
    stubClient(),
    outboundMeta,
    {} as never,
    {} as never,
  );
  ctrl.onModuleInit();
  return ctrl;
}

/** Запрос с уже разрешёнными гвардом донорскими скоупами. */
function reqWithDonors(donors: Record<string, { scope: string; predicate?: string } | null>) {
  return {
    headers: {},
    user: { userId: 'u1' },
    __visibilityScope: 'scope-companies',
    __accessPredicate: 'pred-companies',
    __donorAccess: donors,
  } as never;
}

const allDonors = () =>
  reqWithDonors({
    contacts: { scope: 'scope-contacts', predicate: 'pred-contacts' },
    deals: { scope: 'scope-deals' },
    orders: { scope: 'scope-orders' },
    activities: { scope: 'scope-activities' },
  });

describe('[be-gw-companies] FR-COMPANIES-375: карточка ходит к донорам под ИХ скоупом', () => {
  it('маршруты карточки размечены @RequireDonorSubjects', () => {
    expect(
      Reflect.getMetadata(
        REQUIRED_DONOR_SUBJECTS_KEY,
        V1DataBffController.prototype.getCompanyCard as never,
      ),
    ).toEqual(['contacts', 'deals', 'orders', 'activities']);
    expect(
      Reflect.getMetadata(
        REQUIRED_DONOR_SUBJECTS_KEY,
        V1DataBffController.prototype.getCompanyContacts as never,
      ),
    ).toEqual(['contacts']);
  });

  it('без __donorAccess донорские блоки пустые (fail-closed, не наследуют companies-скоуп)', async () => {
    const listDeals = jest.fn((_r: unknown, _md?: unknown) =>
      of({ list: [{ id: 'd1' }], total: 1 }),
    );
    const listContacts = jest.fn((_r: unknown, _md?: unknown) =>
      of({ list: [{ id: 'c1', company_ids: ['co1'] }], total: 1 }),
    );
    const ctrl = build({
      company: { getCompany: () => of({ id: 'co1' }) },
      contact: { listContacts },
      pipe: { listDeals },
      orders: { listOrders: () => of({ list: [], total: 0 }) },
      activity: { listActivities: () => of({ list: [] }) },
    });

    const res = (await ctrl.getCompanyCard(
      {
        headers: {},
        user: { userId: 'u1' },
        __visibilityScope: 'scope-companies',
        __accessPredicate: 'pred-companies',
      } as never,
      'co1',
      'p1',
    )) as unknown as {
      contacts: unknown[];
      deals: unknown[];
      stats: Record<string, number>;
    };

    expect(listContacts).not.toHaveBeenCalled();
    expect(listDeals).not.toHaveBeenCalled();
    expect(res.contacts).toEqual([]);
    expect(res.deals).toEqual([]);
    expect(res.stats.dealsTotal).toBe(0);
    expect(res.stats.contactsCount).toBe(0);
  });

  it('каждому донору уезжает его собственный scope, а не companies', async () => {
    const listDeals = jest.fn((_r: unknown, _md?: unknown) => of({ list: [], total: 0 }));
    const listOrders = jest.fn((_r: unknown, _md?: unknown) => of({ list: [], total: 0 }));
    const listActivities = jest.fn((_r: unknown, _md?: unknown) => of({ list: [] }));
    const listContacts = jest.fn((_r: unknown, _md?: unknown) => of({ list: [], total: 0 }));
    const listEvents = jest.fn((_r: unknown, _md?: unknown) => of({ list: [] }));
    const ctrl = build({
      company: { getCompany: () => of({ id: 'co1' }) },
      contact: { listContacts },
      pipe: { listDeals },
      orders: { listOrders },
      activity: { listActivities },
      audit: { listEvents },
    });

    await ctrl.getCompanyCard(allDonors(), 'co1', 'p1');

    expect(listContacts.mock.calls[0][1]).toEqual({
      scope: 'scope-contacts',
      predicate: 'pred-contacts',
    });
    expect(listDeals.mock.calls[0][1]).toEqual({ scope: 'scope-deals', predicate: null });
    expect(listOrders.mock.calls[0][1]).toEqual({ scope: 'scope-orders', predicate: null });
    expect(listActivities.mock.calls[0][1]).toEqual({
      scope: 'scope-activities',
      predicate: null,
    });
    // История — собственный аудит компании, гейт уже отработал на getCompany.
    expect(listEvents.mock.calls[0][1]).toEqual({
      scope: 'scope-companies',
      predicate: 'pred-companies',
    });
  });

  it('донор, недоступный на чтение (null), гасит только свой блок и до домена не доходит', async () => {
    const listDeals = jest.fn((_r: unknown, _md?: unknown) =>
      of({ list: [{ id: 'd1' }], total: 7 }),
    );
    const listOrders = jest.fn((_r: unknown, _md?: unknown) =>
      of({ list: [{ id: 'o1' }], total: 1 }),
    );
    const ctrl = build({
      company: { getCompany: () => of({ id: 'co1' }) },
      contact: { listContacts: () => of({ list: [], total: 0 }) },
      pipe: { listDeals },
      orders: { listOrders },
      activity: { listActivities: () => of({ list: [] }) },
    });

    const res = (await ctrl.getCompanyCard(
      reqWithDonors({
        contacts: { scope: 'scope-contacts' },
        deals: null,
        orders: { scope: 'scope-orders' },
        activities: null,
      }),
      'co1',
      'p1',
    )) as unknown as { deals: unknown[]; activities: unknown[]; stats: Record<string, number> };

    expect(listDeals).not.toHaveBeenCalled();
    expect(res.deals).toEqual([]);
    expect(res.activities).toEqual([]);
    expect(res.stats.dealsTotal).toBe(0);
    expect(res.stats.dealsWon).toBe(0);
    // Разрешённый донор при этом работает как обычно.
    expect(listOrders).toHaveBeenCalled();
    expect(res.stats.ordersTotal).toBe(1);
  });

  it('контакты запрашиваются одним вызовом с filter_company_id (доменный фильтр)', async () => {
    const listContacts = jest.fn((_r: unknown, _md?: unknown) =>
      of({
        list: [
          { id: 'c1', company_ids: ['co1'] },
          { id: 'c2', company_ids: ['co1'] },
        ],
        total: 2,
      }),
    );
    const ctrl = build({
      company: { getCompany: () => of({ id: 'co1' }) },
      contact: { listContacts },
      pipe: { listDeals: () => of({ list: [], total: 0 }) },
      orders: { listOrders: () => of({ list: [], total: 0 }) },
      activity: { listActivities: () => of({ list: [] }) },
    });

    const res = (await ctrl.getCompanyCard(allDonors(), 'co1', 'p1')) as unknown as {
      contacts: { id: string }[];
      stats: Record<string, number | boolean>;
    };

    expect(listContacts).toHaveBeenCalledTimes(1);
    expect(listContacts.mock.calls[0][0]).toMatchObject({
      page_index: 0,
      page_size: 100,
      filter_company_id: 'co1',
    });
    expect(res.contacts.map((c) => c.id)).toEqual(['c1', 'c2']);
    expect(res.stats.contactsCount).toBe(2);
    expect(res.stats.contactsTruncated).toBe(false);
  });

  it('GET /companies/:id/contacts: сначала гейт по компании, потом контакты под contacts-скоупом', async () => {
    const getCompany = jest.fn(() => of({ id: 'co1' }));
    const listContacts = jest.fn((_r: unknown, _md?: unknown) =>
      of({ list: [{ id: 'c1', company_ids: ['co1'] }], total: 1 }),
    );
    const ctrl = build({ company: { getCompany }, contact: { listContacts } });

    const res = (await ctrl.getCompanyContacts(
      reqWithDonors({ contacts: { scope: 'scope-contacts' } }),
      'co1',
      'p1',
    )) as unknown as { list: unknown[]; total: number };

    expect(getCompany).toHaveBeenCalled();
    expect(listContacts.mock.calls[0][1]).toEqual({ scope: 'scope-contacts', predicate: null });
    expect(res.total).toBe(1);
  });

  it('GET /companies/:id/contacts при запрещённом доноре отдаёт пусто, а не companies-скоуп', async () => {
    const listContacts = jest.fn((_r: unknown, _md?: unknown) => of({ list: [], total: 0 }));
    const ctrl = build({
      company: { getCompany: () => of({ id: 'co1' }) },
      contact: { listContacts },
    });

    const res = (await ctrl.getCompanyContacts(
      reqWithDonors({ contacts: null }),
      'co1',
      'p1',
    )) as unknown as { list: unknown[]; total: number };

    expect(listContacts).not.toHaveBeenCalled();
    expect(res).toMatchObject({ list: [], total: 0 });
  });
});

/**
 * API-GET-companies-contacts: доменный `filter_company_id` даёт точный total.
 * Список на карточке — первая страница; если она короче total, флаг
 * `contactsTruncated` обязан сказать об этом вслух.
 */
describe('[be-gw-companies] карточка: контакты по доменному фильтру company_id', () => {
  it('счётчик берёт total домена; список короче total ⇒ truncated=true', async () => {
    const listContacts = jest.fn((_r: unknown, _md?: unknown) =>
      of({
        list: [{ id: 'linked-1', company_ids: ['co1'] }],
        total: 5000,
      }),
    );
    const ctrl = build({
      company: { getCompany: () => of({ id: 'co1' }) },
      contact: { listContacts },
      pipe: { listDeals: () => of({ list: [], total: 0 }) },
      orders: { listOrders: () => of({ list: [], total: 0 }) },
      activity: { listActivities: () => of({ list: [] }) },
    });

    const res = (await ctrl.getCompanyCard(allDonors(), 'co1', 'p1')) as unknown as {
      contacts: unknown[];
      stats: Record<string, number | boolean>;
    };

    expect(listContacts).toHaveBeenCalledTimes(1);
    expect(listContacts.mock.calls[0][0]).toMatchObject({ filter_company_id: 'co1' });
    expect(res.stats.contactsCount).toBe(5000);
    expect(res.contacts).toHaveLength(1);
    expect(res.stats.contactsTruncated).toBe(true);
  });
});

/**
 * Ревью круга 1: счётчики связей в предпросмотре слияния считались под скоупом
 * СУБЪЕКТА companies, отданным донорам pipe/orders/activity/documents/contact.
 * Донор применял свой `buildVisibilityFilter` по companies-резолюции, поэтому
 * число не было ни количеством перепривязываемых записей (merge через
 * `crm.company.merged` перешивает ВСЁ в проекте), ни количеством видимых
 * пользователю — произвольный гибрид, на котором принимают решение о слиянии.
 *
 * Решение: счётчики — про масштаб операции, считаются под явным project-wide
 * скоупом (`mode:'all'`, без ABAC-предиката) и подписаны в ответе
 * `relationsScope: 'project'`. Сам previewMerge (доступ к обеим компаниям)
 * по-прежнему идёт под маршрутным скоупом.
 */
describe('[be-gw-companies] merge/preview: счётчики — масштаб слияния, а не видимость', () => {
  const mergeClients = (over: Clients = {}) => ({
    company: { previewMerge: () => of({ field_conflicts: [] }) },
    contact: { listContacts: () => of({ list: [], total: 0 }) },
    pipe: { listDeals: () => of({ list: [], total: 0 }) },
    orders: { listOrders: () => of({ list: [], total: 0 }) },
    activity: { listActivities: () => of({ list: [], total: 0 }) },
    documents: { listDocuments: () => of({ list: [], total: 0 }) },
    ...over,
  });

  it('донорам уезжает project-wide scope без ABAC-предиката, а не companies-скоуп', async () => {
    const seen: Record<string, unknown[]> = {
      deals: [],
      orders: [],
      activities: [],
      documents: [],
      contacts: [],
    };
    const previewMerge = jest.fn((_r: unknown, _md?: unknown) => of({ field_conflicts: [] }));
    const ctrl = build(
      mergeClients({
        company: { previewMerge },
        pipe: {
          listDeals: (_r: unknown, md?: unknown) => (
            seen.deals.push(md),
            of({ list: [], total: 0 })
          ),
        },
        orders: {
          listOrders: (_r: unknown, md?: unknown) => (
            seen.orders.push(md),
            of({ list: [], total: 0 })
          ),
        },
        activity: {
          listActivities: (_r: unknown, md?: unknown) => (
            seen.activities.push(md),
            of({ list: [], total: 0 })
          ),
        },
        documents: {
          listDocuments: (_r: unknown, md?: unknown) => (
            seen.documents.push(md),
            of({ list: [], total: 0 })
          ),
        },
        contact: {
          listContacts: (_r: unknown, md?: unknown) => (
            seen.contacts.push(md),
            of({ list: [], total: 0 })
          ),
        },
      }),
    );

    const res = (await ctrl.previewCompanyMerge(reqWithDonors({}), 'p1', {
      masterId: 'm1',
      loserId: 'l1',
    })) as unknown as { relationsScope: string };

    // Сам предпросмотр (гейт доступа к обеим компаниям) — под маршрутным скоупом.
    expect(previewMerge.mock.calls[0][1]).toEqual({
      scope: 'scope-companies',
      predicate: 'pred-companies',
    });
    // Все доноры — под явным project-wide скоупом, предикат снят.
    const donorMds = Object.values(seen).flat();
    expect(donorMds.length).toBe(10); // 5 доноров × 2 компании (master + loser)
    for (const md of donorMds) {
      const { scope, predicate } = md as { scope: string; predicate: string | null };
      expect(predicate).toBeNull();
      expect(scope).not.toBe('scope-companies');
      expect(parseVisibilityScope(scope)).toMatchObject({ mode: 'all', ownerIds: [] });
    }
    // Семантика подписана в контракте ответа.
    expect(res.relationsScope).toBe('project');
  });

  it('счётчики берут total донора, а не длину первой страницы', async () => {
    const ctrl = build(
      mergeClients({
        pipe: { listDeals: () => of({ list: [{ id: 'd1' }], total: 137 }) },
        orders: { listOrders: () => of({ list: [{ id: 'o1' }], total: 42 }) },
        // До правки activities/documents считались как `list.length` и упирались
        // в LINKS_PAGE_SIZE=100: 400 активностей превращались в 100.
        activity: { listActivities: () => of({ list: [{ id: 'a1' }], total: 400 }) },
        documents: { listDocuments: () => of({ list: [{ group_id: 'g1' }], total: 7 }) },
      }),
    );

    const res = (await ctrl.previewCompanyMerge(reqWithDonors({}), 'p1', {
      masterId: 'm1',
      loserId: 'l1',
    })) as unknown as { relations: Record<string, number | boolean> };

    expect(res.relations).toMatchObject({
      deals: 137,
      orders: 42,
      activities: 400,
      documents: 7,
    });
  });

  it('счётчик контактов в preview merge — total домена по filter_company_id', async () => {
    const listContacts = jest.fn((_r: unknown, _md?: unknown) =>
      of({
        list: Array.from({ length: 100 }, (_, i) => ({ id: `c${i}`, company_ids: ['l1'] })),
        total: 9000,
      }),
    );
    const ctrl = build(mergeClients({ contact: { listContacts } }));

    const res = (await ctrl.previewCompanyMerge(reqWithDonors({}), 'p1', {
      masterId: '',
      loserId: 'l1',
    })) as unknown as { relations: Record<string, number | boolean> };

    expect(res.relations.contacts).toBe(9000);
    expect(res.relations.contactsTruncated).toBe(false);
    expect(listContacts.mock.calls[0][0]).toMatchObject({ filter_company_id: 'l1' });
  });

  it('донор лёг ⇒ счётчик 0, а не 500', async () => {
    const ctrl = build(
      mergeClients({
        pipe: {
          listDeals: () => {
            throw new Error('pipe down');
          },
        },
      }),
    );

    const res = (await ctrl.previewCompanyMerge(reqWithDonors({}), 'p1', {
      masterId: 'm1',
      loserId: 'l1',
    })) as unknown as { relations: Record<string, number | boolean> };

    expect(res.relations.deals).toBe(0);
  });
});
