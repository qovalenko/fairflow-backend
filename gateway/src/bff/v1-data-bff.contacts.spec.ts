/**
 * [be-gw-contacts] Шлюз → домен «Контакты»: параметры, которые фронт шлёт, а
 * gateway раньше молча выбрасывал.
 *
 *  1) FR-CONTACTS-050/170/190 — create/update теряли middleName, notes, tags и
 *     M2M-список компаний: форма редактирования их отправляет, модель их хранит,
 *     а хендлер шлюза мапил только 8 полей. Класс дефекта «домен умеет, а до
 *     пользователя не доходит» — тут в обратную сторону.
 *  2) FR-CONTACTS-030/300 — фильтры «источник»/«ответственный» и сортировка по
 *     колонке не доезжали до домена (клиентской фильтрации в таблице нет вовсе).
 *
 * Отдельно фиксируем контракт proto: поля обязаны быть ОБЪЯВЛЕНЫ в
 * Create/Update/ListContactsRequest — иначе `@grpc/proto-loader` выкинет их из
 * payload молча и правка шлюза окажется декоративной (та же грабля, что с
 * keepCase/longs).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { of } from 'rxjs';
import type { ClientGrpcProxy } from '@nestjs/microservices';
import { V1DataBffController } from './v1-data-bff.controller';

function stubClient(service: Record<string, unknown> = {}): ClientGrpcProxy {
  return { getService: () => service } as unknown as ClientGrpcProxy;
}

function build(contact: Record<string, unknown>, company: Record<string, unknown> = {}) {
  const outboundMeta = { build: () => ({}) } as never;
  const ctrl = new V1DataBffController(
    stubClient(), // control
    stubClient(contact), // contact (2nd)
    stubClient(company), // company
    stubClient(), // auth
    stubClient(), // notification
    stubClient(), // audit
    stubClient(), // pipe
    stubClient(), // orders
    stubClient(), // activity
    stubClient(), // documents
    stubClient(), // search
    outboundMeta,
    {} as never, // config
    {} as never, // orgLogoStorage
  );
  ctrl.onModuleInit();
  return ctrl;
}

const CONTACT_ROW = { id: 'c1', first_name: 'Иван', company_ids: [] };
const req = (query: Record<string, unknown> = {}) =>
  ({ headers: {}, query, user: { userId: 'u1' } }) as never;

describe('[be-gw-contacts] create/update field passthrough (FR-CONTACTS-050/170/190)', () => {
  it('createContact доносит middleName, notes, tags и companyIds до домена', async () => {
    const createContact = jest.fn((_p: Record<string, unknown>, _m?: unknown) => of(CONTACT_ROW));
    const ctrl = build({ createContact });

    await ctrl.createContact(
      req(),
      {
        firstName: 'Иван',
        lastName: 'Петров',
        middleName: 'Сергеевич',
        notes: 'важный',
        tags: ['vip', ' partner '],
        companyIds: ['co1', 'co2'],
        companyId: 'co1',
      },
      'p1',
    );

    const payload = createContact.mock.calls[0][0] as Record<string, unknown>;
    expect(payload.middle_name).toBe('Сергеевич');
    expect(payload.notes).toBe('важный');
    expect(payload.tags).toEqual(['vip', 'partner']);
    // Не только первая компания — связь M2M.
    expect(payload.company_ids).toEqual(['co1', 'co2']);
  });

  it('createContact поднимает одиночный companyId в список (старые клиенты)', async () => {
    const createContact = jest.fn((_p: Record<string, unknown>, _m?: unknown) => of(CONTACT_ROW));
    const ctrl = build({ createContact });

    await ctrl.createContact(req(), { firstName: 'И', companyId: 'co9' }, 'p1');

    const payload = createContact.mock.calls[0][0] as Record<string, unknown>;
    expect(payload.company_ids).toEqual(['co9']);
  });

  it('updateContact доносит те же поля и помечает списки как присланные', async () => {
    const updateContact = jest.fn((_p: Record<string, unknown>, _m?: unknown) => of(CONTACT_ROW));
    const ctrl = build({ updateContact });

    await ctrl.updateContact(req(), 'c1', 'p1', {
      firstName: 'Иван',
      middleName: 'Сергеевич',
      notes: 'заметка',
      tags: ['a'],
      companyIds: ['co1', 'co2'],
    });

    const payload = updateContact.mock.calls[0][0] as Record<string, unknown>;
    expect(payload.middle_name).toBe('Сергеевич');
    expect(payload.notes).toBe('заметка');
    expect(payload.tags).toEqual(['a']);
    expect(payload.set_tags).toBe(true);
    expect(payload.company_ids).toEqual(['co1', 'co2']);
    expect(payload.set_company_ids).toBe(true);
  });

  it('updateContact без списков не помечает их присланными (частичный PUT ничего не стирает)', async () => {
    const updateContact = jest.fn((_p: Record<string, unknown>, _m?: unknown) => of(CONTACT_ROW));
    const ctrl = build({ updateContact });

    await ctrl.updateContact(req(), 'c1', 'p1', { position: 'CTO' });

    const payload = updateContact.mock.calls[0][0] as Record<string, unknown>;
    expect(payload.set_tags).toBe(false);
    expect(payload.set_company_ids).toBe(false);
  });

  it('updateContact с пустым списком — это явная очистка, а не «не менять»', async () => {
    const updateContact = jest.fn((_p: Record<string, unknown>, _m?: unknown) => of(CONTACT_ROW));
    const ctrl = build({ updateContact });

    await ctrl.updateContact(req(), 'c1', 'p1', { tags: [], companyIds: [] });

    const payload = updateContact.mock.calls[0][0] as Record<string, unknown>;
    expect(payload.tags).toEqual([]);
    expect(payload.set_tags).toBe(true);
    expect(payload.company_ids).toEqual([]);
    expect(payload.set_company_ids).toBe(true);
  });
});

describe('[be-gw-contacts] list filters and sort (FR-CONTACTS-030/300)', () => {
  const listResp = () => of({ list: [CONTACT_ROW], total: 1 });

  it('прокидывает source и assigneeId (→ owner_id) в домен', async () => {
    const listContacts = jest.fn((_p: Record<string, unknown>, _m?: unknown) => listResp());
    const ctrl = build({ listContacts });

    await ctrl.listContacts(req(), 'p1', '0', '10', '', undefined, 'website', 'u7');

    const payload = listContacts.mock.calls[0][0] as Record<string, unknown>;
    expect(payload.source).toBe('website');
    expect(payload.owner_id).toBe('u7');
  });

  it('читает плоскую сортировку sortBy/sortDir', async () => {
    const listContacts = jest.fn((_p: Record<string, unknown>, _m?: unknown) => listResp());
    const ctrl = build({ listContacts });

    await ctrl.listContacts(
      req(),
      'p1',
      '0',
      '10',
      '',
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      'lastName',
      'asc',
    );

    const payload = listContacts.mock.calls[0][0] as Record<string, unknown>;
    expect(payload.sort_by).toBe('lastName');
    expect(payload.sort_dir).toBe('asc');
  });

  it('читает вложенную форму таблицы sort[key]/sort[order] (так её сериализует axios)', async () => {
    const listContacts = jest.fn((_p: Record<string, unknown>, _m?: unknown) => listResp());
    const ctrl = build({ listContacts });

    await ctrl.listContacts(
      req({ 'sort[key]': 'email', 'sort[order]': 'desc' }),
      'p1',
      '0',
      '10',
      '',
    );

    const payload = listContacts.mock.calls[0][0] as Record<string, unknown>;
    expect(payload.sort_by).toBe('email');
    expect(payload.sort_dir).toBe('desc');
  });

  it('читает sort как объект, если query-парсер отдал его вложенным', async () => {
    const listContacts = jest.fn((_p: Record<string, unknown>, _m?: unknown) => listResp());
    const ctrl = build({ listContacts });

    await ctrl.listContacts(req({ sort: { key: 'phone', order: 'asc' } }), 'p1', '0', '10', '');

    const payload = listContacts.mock.calls[0][0] as Record<string, unknown>;
    expect(payload.sort_by).toBe('phone');
    expect(payload.sort_dir).toBe('asc');
  });

  it('поле вне whitelist не уезжает в домен (сортировка не зонд по документу)', async () => {
    const listContacts = jest.fn((_p: Record<string, unknown>, _m?: unknown) => listResp());
    const ctrl = build({ listContacts });

    await ctrl.listContacts(
      req({ 'sort[key]': 'ownerId', 'sort[order]': 'asc' }),
      'p1',
      '0',
      '10',
      '',
    );

    const payload = listContacts.mock.calls[0][0] as Record<string, unknown>;
    expect(payload.sort_by).toBe('');
    expect(payload.sort_dir).toBe('');
  });

  it('фильтры не подменяют projectId — он берётся только из query', async () => {
    const listContacts = jest.fn((_p: Record<string, unknown>, _m?: unknown) => listResp());
    const ctrl = build({ listContacts });

    await ctrl.listContacts(req({ projectId: 'evil' }), 'p1', '0', '10', '', undefined, 's', 'u7');

    const payload = listContacts.mock.calls[0][0] as Record<string, unknown>;
    expect(payload.project_id).toBe('p1');
  });
});

describe('[be-gw-contacts] proto объявляет поля, иначе loader выкинет их молча', () => {
  const proto = readFileSync(
    join(__dirname, '../../../proto/fairflow/contact/v1/contact.proto'),
    'utf8',
  );
  const block = (name: string) => {
    const start = proto.indexOf(`message ${name} {`);
    expect(start).toBeGreaterThan(-1);
    return proto.slice(start, proto.indexOf('\n}', start));
  };

  it.each(['middle_name', 'notes', 'repeated string tags', 'repeated string company_ids'])(
    'CreateContactRequest содержит %s',
    (field) => {
      expect(block('CreateContactRequest')).toContain(field);
    },
  );

  it.each([
    'middle_name',
    'notes',
    'repeated string tags',
    'bool set_tags',
    'repeated string company_ids',
    'bool set_company_ids',
  ])('UpdateContactRequest содержит %s', (field) => {
    expect(block('UpdateContactRequest')).toContain(field);
  });

  it.each(['string source', 'string owner_id', 'string sort_by', 'string sort_dir'])(
    'ListContactsRequest содержит %s',
    (field) => {
      expect(block('ListContactsRequest')).toContain(field);
    },
  );

  it('ImportContactsResponse умеет updated и построчные пропуски', () => {
    expect(block('ImportContactsResponse')).toContain('int32 updated');
    expect(block('ImportContactsResponse')).toContain('repeated ImportSkippedRow skipped_rows');
    expect(block('ImportSkippedRow')).toContain('matched_contact_id');
  });
});

/**
 * EXTRA-CONTACTS-1 (доработка после ревью) — кнопка «Экспорт всех контактов»
 * обещает ВЕСЬ набор, а шлюз просил у домена одну страницу page_size=1000,
 * которую домен молча клампил до MAX_PAGE_SIZE=100. В проекте с >100 контактами
 * файл содержал первые 100 строк, и пользователь об этом не узнавал.
 */
describe('[be-gw-contacts] экспорт контактов выгружает весь набор постранично', () => {
  const res = () => ({ header: jest.fn() }) as never;
  /** Домен с `n` контактами и клампом страницы до 100, как в contact-сервисе. */
  const pagedDomain = (n: number, reportedTotal = n) =>
    jest.fn((p: Record<string, unknown>, _m?: unknown) => {
      const size = Math.min((p.page_size as number) ?? 25, 100);
      const from = ((p.page_index as number) ?? 0) * size;
      const list = Array.from({ length: Math.max(Math.min(size, n - from), 0) }, (_, i) => ({
        id: `c${from + i}`,
        first_name: `Имя${from + i}`,
        company_ids: [],
      }));
      return of({ list, total: reportedTotal });
    });

  it('идёт по страницам домена: 250 контактов → 250 строк в CSV, а не 100', async () => {
    const listContacts = pagedDomain(250);
    const ctrl = build({ listContacts });

    const buf = (await ctrl.exportContacts(req(), res(), 'p1', 'csv')) as Buffer;

    const lines = buf.toString('utf8').split('\n');
    expect(lines).toHaveLength(251); // заголовок + 250 строк
    expect(lines[1]).toContain('Имя0');
    expect(lines[250]).toContain('Имя249');
    expect(listContacts).toHaveBeenCalledTimes(3);
  });

  it('просит у домена ровно его максимум страницы и стабильный порядок createdAt asc', async () => {
    const listContacts = pagedDomain(150);
    const ctrl = build({ listContacts });

    await ctrl.exportContacts(req(), res(), 'p1', 'csv', 'ив');

    const first = listContacts.mock.calls[0][0] as Record<string, unknown>;
    // page_size>100 домен всё равно обрежет — просить больше нельзя.
    expect(first.page_size).toBe(100);
    expect(first.page_index).toBe(0);
    expect(first.query).toBe('ив');
    // updatedAt desc (дефолт) «плывёт» при параллельной правке — skip-пагинация
    // теряла бы строки; createdAt неизменен.
    expect(first.sort_by).toBe('createdAt');
    expect(first.sort_dir).toBe('asc');
    expect((listContacts.mock.calls[1][0] as Record<string, unknown>).page_index).toBe(1);
  });

  it('json-формат тоже отдаёт весь набор', async () => {
    const ctrl = build({ listContacts: pagedDomain(120) });

    const buf = (await ctrl.exportContacts(req(), res(), 'p1', 'json')) as Buffer;

    expect(JSON.parse(buf.toString('utf8'))).toHaveLength(120);
  });

  it('выборка больше потолка выгрузки — явная ошибка, а не тихо обрезанный файл', async () => {
    const ctrl = build({ listContacts: pagedDomain(100, 50_001) });

    await expect(ctrl.exportContacts(req(), res(), 'p1', 'csv')).rejects.toThrow(/50000/);
  });

  it('повтор записи на «плывущих» страницах не удваивает строку в файле', async () => {
    const listContacts = jest.fn((p: Record<string, unknown>, _m?: unknown) =>
      (p.page_index as number) === 0
        ? of({ list: Array.from({ length: 100 }, (_, i) => ({ id: `c${i}` })), total: 150 })
        : of({ list: Array.from({ length: 50 }, (_, i) => ({ id: `c${90 + i}` })), total: 150 }),
    );
    const ctrl = build({ listContacts });

    const buf = (await ctrl.exportContacts(req(), res(), 'p1', 'json')) as Buffer;

    const ids = (JSON.parse(buf.toString('utf8')) as { id: string }[]).map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toHaveLength(140);
  });

  it('домен не сообщил total — идём до короткой страницы, а не до первой', async () => {
    const listContacts = jest.fn((p: Record<string, unknown>, _m?: unknown) => {
      const from = ((p.page_index as number) ?? 0) * 100;
      const n = Math.max(Math.min(100, 230 - from), 0);
      return of({ list: Array.from({ length: n }, (_, i) => ({ id: `c${from + i}` })) });
    });
    const ctrl = build({ listContacts });

    const buf = (await ctrl.exportContacts(req(), res(), 'p1', 'json')) as Buffer;

    expect(JSON.parse(buf.toString('utf8'))).toHaveLength(230);
  });

  it('пустой проект — только строка заголовков, один запрос в домен', async () => {
    const listContacts = pagedDomain(0);
    const ctrl = build({ listContacts });

    const buf = (await ctrl.exportContacts(req(), res(), 'p1', 'csv')) as Buffer;

    expect(buf.toString('utf8').split('\n')).toHaveLength(1);
    expect(listContacts).toHaveBeenCalledTimes(1);
  });
});

describe('[be-gw-contacts] company reverse lookup (API-GET-companies-contacts)', () => {
  it('getCompanyContacts шлёт filter_company_id вместо sweep', async () => {
    const getCompany = jest.fn((_p: Record<string, unknown>, _m?: unknown) =>
      of({ id: 'co1', name: 'ACME' }),
    );
    const listContacts = jest.fn((_p: Record<string, unknown>, _m?: unknown) =>
      of({ list: [{ id: 'c1', first_name: 'Иван', company_ids: ['co1'] }], total: 1 }),
    );
    const ctrl = build({ listContacts }, { getCompany });
    (ctrl as unknown as { donorMd: () => unknown }).donorMd = () => ({});

    const res = (await ctrl.getCompanyContacts(req({ projectId: 'p1' }), 'co1', 'p1')) as {
      list: unknown[];
      total: number;
      truncated: boolean;
    };
    expect(res.total).toBe(1);
    expect(res.truncated).toBe(false);
    const payload = listContacts.mock.calls[0][0] as Record<string, unknown>;
    expect(payload.filter_company_id).toBe('co1');
  });

  it('getCompanyContacts: страница короче total ⇒ truncated=true', async () => {
    const getCompany = jest.fn((_p: Record<string, unknown>, _m?: unknown) =>
      of({ id: 'co1', name: 'ACME' }),
    );
    const listContacts = jest.fn((_p: Record<string, unknown>, _m?: unknown) =>
      of({
        list: [{ id: 'c1', first_name: 'Иван', company_ids: ['co1'] }],
        total: 250,
      }),
    );
    const ctrl = build({ listContacts }, { getCompany });
    (ctrl as unknown as { donorMd: () => unknown }).donorMd = () => ({});

    const res = (await ctrl.getCompanyContacts(req({ projectId: 'p1' }), 'co1', 'p1')) as {
      list: unknown[];
      total: number;
      truncated: boolean;
    };
    expect(res.list).toHaveLength(1);
    expect(res.total).toBe(250);
    expect(res.truncated).toBe(true);
  });
});
