/**
 * [be-gw-losses] Сквозной путь данных «домен умеет — до пользователя не доходит»
 * для v1-data-bff (контакты / компании).
 *
 * Покрывает три восстановленных потери:
 *  1. FR-CONTACTS-050 — middle_name терялся на ОТВЕТЕ (mapContact не давал camelCase);
 *  2. FR-COMPANIES-010/280/290 — filter_* и sort_* терялись на ЗАПРОСЕ (gateway не
 *     объявлял query-параметры, хотя proto и домен их поддерживают);
 *  3. FR-COMPANIES-440 — multipart-импорт: файл не доезжал до домена (@Body() пуст
 *     на multipart), а список ошибок домена не мапился в форму, которую ждёт мастер.
 */
import { of } from 'rxjs';
import type { ClientGrpcProxy } from '@nestjs/microservices';
import { V1DataBffController } from './v1-data-bff.controller';

function stubClient(service: Record<string, unknown> = {}): ClientGrpcProxy {
  return { getService: () => service } as unknown as ClientGrpcProxy;
}

function build(opts: { contact?: Record<string, unknown>; company?: Record<string, unknown> }) {
  const outboundMeta = { build: () => ({}) } as never;
  const ctrl = new V1DataBffController(
    stubClient(),
    stubClient(opts.contact ?? {}),
    stubClient(opts.company ?? {}),
    stubClient(),
    stubClient(),
    stubClient(),
    stubClient(),
    stubClient(),
    stubClient(),
    stubClient(),
    stubClient(),
    outboundMeta,
    {} as never,
    {} as never,
  );
  ctrl.onModuleInit();
  return ctrl;
}

const req = { headers: {}, user: { userId: 'u1' } } as never;

describe('[be-gw-losses] contacts: middleName survives the response mapping', () => {
  it('getContact exposes middleName (camelCase) from domain middle_name', async () => {
    const getContact = jest.fn(() =>
      of({
        id: 'c1',
        first_name: 'Иван',
        last_name: 'Петров',
        middle_name: 'Сергеевич',
        company_ids: ['co1', 'co2'],
        owner_id: 'u9',
        tags: ['vip'],
        notes: 'заметка',
      }),
    );
    const ctrl = build({ contact: { getContact } });

    const res = (await ctrl.getContact(req, 'c1', 'p1')) as Record<string, unknown>;

    expect(res.middleName).toBe('Сергеевич');
    // соседние поля не задеты
    expect(res.firstName).toBe('Иван');
    expect(res.companyIds).toEqual(['co1', 'co2']);
    expect(res.companyId).toBe('co1');
    expect(res.tags).toEqual(['vip']);
    expect(res.notes).toBe('заметка');
  });

  it('listContacts maps middleName for every row', async () => {
    const listContacts = jest.fn(() =>
      of({ list: [{ id: 'c1', middle_name: 'Иванович' }, { id: 'c2' }], total: 2 }),
    );
    const ctrl = build({ contact: { listContacts, listTrash: jest.fn() } });

    const res = (await ctrl.listContacts(req, 'p1')) as {
      list: Record<string, unknown>[];
    };

    expect(res.list[0].middleName).toBe('Иванович');
    expect(res.list[1].middleName).toBeUndefined();
  });
});

describe('[be-gw-losses] companies: list filters and sort reach the domain', () => {
  it('forwards filter_*/sort_* from query params', async () => {
    const listCompanies = jest.fn((_p: Record<string, unknown>, _m?: unknown) =>
      of({ list: [], total: 0 }),
    );
    const ctrl = build({ company: { listCompanies } });

    await ctrl.listCompanies(
      req,
      'p1',
      '2',
      '50',
      'акме',
      'owner-7',
      'dep-3',
      'client',
      'it',
      'msk',
      'vip,gold',
      'name',
      'asc',
    );

    expect(listCompanies).toHaveBeenCalledTimes(1);
    expect(listCompanies.mock.calls[0][0]).toMatchObject({
      project_id: 'p1',
      page_index: 2,
      page_size: 50,
      query: 'акме',
      filter_owner_id: 'owner-7',
      filter_department_id: 'dep-3',
      filter_status: 'client',
      filter_industry: 'it',
      filter_region: 'msk',
      filter_tags: 'vip,gold',
      sort_by: 'name',
      sort_dir: 'asc',
    });
  });

  it('omitted filters go over the wire as empty strings (domain treats them as unset)', async () => {
    const listCompanies = jest.fn((_p: Record<string, unknown>, _m?: unknown) =>
      of({ list: [], total: 0 }),
    );
    const ctrl = build({ company: { listCompanies } });

    await ctrl.listCompanies(req, 'p1');

    expect(listCompanies.mock.calls[0][0]).toMatchObject({
      filter_owner_id: '',
      filter_status: '',
      sort_by: '',
      sort_dir: '',
    });
  });
});

describe('[be-gw-losses] companies: multipart import', () => {
  function multipartReq(parts: Array<Record<string, unknown>>): never {
    return {
      headers: {},
      user: { userId: 'u1' },
      isMultipart: () => true,
      parts: () => ({
        async *[Symbol.asyncIterator]() {
          for (const p of parts) yield p;
        },
      }),
    } as never;
  }

  it('reads file + fields from multipart and forwards them to the domain', async () => {
    const importCompanies = jest.fn((_p: Record<string, unknown>, _m?: unknown) =>
      of({ created: 3, updated: 1, skipped: 2, errors: [] }),
    );
    const ctrl = build({ company: { importCompanies } });

    const mreq = multipartReq([
      {
        type: 'file',
        fieldname: 'file',
        filename: 'companies.csv',
        toBuffer: async () => Buffer.from('name,inn\nАкме,7701', 'utf8'),
      },
      { type: 'field', fieldname: 'mappingJson', value: '{"name":"0","inn":"1","email":""}' },
      { type: 'field', fieldname: 'dedupMode', value: 'update' },
    ]);

    const res = (await ctrl.importCompanies(mreq, 'p1')) as Record<string, unknown>;

    const payload = importCompanies.mock.calls[0][0] as Record<string, unknown>;
    expect(payload.project_id).toBe('p1');
    expect((payload.file_content as Buffer).toString('utf8')).toBe('name,inn\nАкме,7701');
    expect(payload.filename).toBe('companies.csv');
    // мастер шлёт {поле: индекс}, домен читает {индекс: поле} — разворачиваем,
    // пустой (очищенный) Select выбрасываем
    expect(JSON.parse(String(payload.mapping_json))).toEqual({ '0': 'name', '1': 'inn' });
    expect(payload.dedup_mode).toBe('update');
    expect(res).toMatchObject({ created: 3, updated: 1, skipped: 2, errors: 0, errorRows: [] });
  });

  it('leaves an already domain-oriented mapping untouched (API clients)', async () => {
    const importCompanies = jest.fn((_p: Record<string, unknown>, _m?: unknown) =>
      of({ created: 1, skipped: 0, errors: [] }),
    );
    const ctrl = build({ company: { importCompanies } });

    await ctrl.importCompanies({ headers: {}, user: { userId: 'u1' } } as never, 'p1', {
      fileContent: 'name\nАкме',
      mappingJson: '{"0":"name","2":"inn"}',
    });

    const payload = importCompanies.mock.calls[0][0] as Record<string, unknown>;
    expect(JSON.parse(String(payload.mapping_json))).toEqual({ '0': 'name', '2': 'inn' });
  });

  it('maps domain ImportRowError[] to a numeric errors count + errorRows list', async () => {
    const importCompanies = jest.fn((_p: Record<string, unknown>, _m?: unknown) =>
      of({
        created: 1,
        skipped: 0,
        errors: [
          { row: 4, message: 'ИНН некорректен' },
          { row: 7, message: 'пустое имя' },
        ],
      }),
    );
    const ctrl = build({ company: { importCompanies } });

    const mreq = multipartReq([
      {
        type: 'file',
        fieldname: 'file',
        filename: 'x.csv',
        toBuffer: async () => Buffer.from('a'),
      },
    ]);

    const res = (await ctrl.importCompanies(mreq, 'p1')) as Record<string, unknown>;

    expect(res.errors).toBe(2);
    expect(res.errorRows).toEqual([
      { row: 4, message: 'ИНН некорректен' },
      { row: 7, message: 'пустое имя' },
    ]);
    expect(res.updated).toBe(0);
    // dedupMode по умолчанию — skip
    expect((importCompanies.mock.calls[0][0] as Record<string, unknown>).dedup_mode).toBe('skip');
  });

  it('still accepts the legacy JSON body (API clients)', async () => {
    const importCompanies = jest.fn((_p: Record<string, unknown>, _m?: unknown) =>
      of({ created: 1, skipped: 0, errors: [] }),
    );
    const ctrl = build({ company: { importCompanies } });

    await ctrl.importCompanies({ headers: {}, user: { userId: 'u1' } } as never, 'p1', {
      fileContent: 'name\nАкме',
      mappingJson: '{}',
      dedupMode: 'create',
    });

    const payload = importCompanies.mock.calls[0][0] as Record<string, unknown>;
    expect((payload.file_content as Buffer).toString('utf8')).toBe('name\nАкме');
    expect(payload.dedup_mode).toBe('create');
  });

  it('rejects an empty upload with 400 instead of silently importing nothing', async () => {
    const importCompanies = jest.fn((_p: Record<string, unknown>, _m?: unknown) => of({}));
    const ctrl = build({ company: { importCompanies } });

    await expect(
      ctrl.importCompanies({ headers: {}, user: { userId: 'u1' } } as never, 'p1', {}),
    ).rejects.toThrow(/файл импорта не передан/);
    expect(importCompanies).not.toHaveBeenCalled();
  });
});
