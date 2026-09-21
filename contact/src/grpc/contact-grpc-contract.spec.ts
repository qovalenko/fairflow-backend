/**
 * Контракт gRPC-контроллера контактов: у КАЖДОГО поля, добавленного в proto,
 * должен быть читатель в домене, и ответ должен нести его обратно. Класс дефектов
 * «домен умеет, а до пользователя не доходит» ловится именно здесь.
 */
import { Metadata } from '@grpc/grpc-js';
import { ContactGrpcController } from './contact.grpc.controller';

type Svc = Record<string, jest.Mock>;

function buildController(overrides: Partial<Svc> = {}) {
  const contacts: Svc = {
    list: jest.fn(async () => ({ list: [], total: 0 })),
    listTrash: jest.fn(async () => ({ list: [], total: 0 })),
    findOne: jest.fn(async () => ({ id: 'c1' })),
    create: jest.fn(async () => ({ id: 'c1' })),
    update: jest.fn(async () => ({ id: 'c1' })),
    findDuplicates: jest.fn(async () => ({ candidates: [], possibleExternalDuplicate: false })),
    countLiveContacts: jest.fn(async () => 0),
    ...(overrides as Svc),
  };
  const idempotency = {
    withIdempotency: (_p: string, _k: unknown, _op: string, fn: () => unknown) => fn(),
  };
  // TODO-160: гейт нового владельца общий у create и reassign — в контрактном
  // тесте подменяем, чтобы видеть, зовут ли его и с чем.
  const reassignTargets = { assertOwnerAssignable: jest.fn(async () => undefined) };
  const ctl = new ContactGrpcController(
    contacts as never,
    idempotency as never,
    reassignTargets as never,
  );
  const md = new Metadata();
  md.set('x-project-id', 'p1');
  md.set('x-user-id', 'user-1');
  return { ctl, contacts, md, reassignTargets };
}

describe('ListContacts: серверные фильтры и сортировка', () => {
  it('source/owner_id/sort_by/sort_dir доезжают до сервиса', async () => {
    const { ctl, contacts, md } = buildController();
    await ctl.listContacts(
      { source: 'web', owner_id: 'user-7', sort_by: 'lastName', sort_dir: 'asc' },
      md,
    );
    const opts = contacts.list.mock.calls[0][7];
    expect(opts).toEqual({
      source: 'web',
      ownerId: 'user-7',
      filterTags: undefined,
      sortBy: 'lastName',
      sortDir: 'asc',
    });
  });
});

describe('CreateContact: поля карточки', () => {
  it('middle_name/notes/tags/company_ids записываются', async () => {
    const { ctl, contacts, md } = buildController();
    await ctl.createContact(
      {
        first_name: 'Иван',
        last_name: 'Иванов',
        email: 'a@b.ru',
        middle_name: 'Петрович',
        notes: 'важный',
        tags: ['vip'],
        company_ids: ['co-1', 'co-2'],
      },
      md,
    );
    expect(contacts.create.mock.calls[0][1]).toMatchObject({
      middleName: 'Петрович',
      notes: 'важный',
      tags: ['vip'],
      companyIds: ['co-1', 'co-2'],
    });
  });

  it('company_id остаётся фолбэком для старых клиентов, дубли схлопываются', async () => {
    const { ctl, contacts, md } = buildController();
    await ctl.createContact({ first_name: 'И', last_name: 'И', company_id: 'co-1' }, md);
    expect(contacts.create.mock.calls[0][1].companyIds).toEqual(['co-1']);

    const second = buildController();
    await second.ctl.createContact(
      { first_name: 'И', last_name: 'И', company_ids: ['co-1', 'co-1', ' '] },
      second.md,
    );
    expect(second.contacts.create.mock.calls[0][1].companyIds).toEqual(['co-1']);
  });
});

/**
 * TODO-160 (симметрия): чужой владелец на create проходит тот же гейт, что и на
 * ReassignContacts. Иначе право contacts:write позволяло назначить владельцем
 * произвольный id — и запись сразу пропадала у всех с видимостью own/unit.
 */
describe('CreateContact: чужой владелец проверяется тем же гейтом, что и reassign', () => {
  it('assignee_id другого пользователя проверяется до записи', async () => {
    const { ctl, contacts, md, reassignTargets } = buildController();
    await ctl.createContact({ first_name: 'И', last_name: 'И', assignee_id: 'user-2' }, md);
    expect(reassignTargets.assertOwnerAssignable).toHaveBeenCalledWith(
      'p1',
      'user-2',
      md,
      'assigneeId',
      undefined,
    );
    expect(contacts.create.mock.calls[0][1].ownerId).toBe('user-2');
  });

  it('отказ гейта не доходит до записи', async () => {
    const { ctl, contacts, md, reassignTargets } = buildController();
    reassignTargets.assertOwnerAssignable.mockRejectedValueOnce(
      Object.assign(new Error('Указан недопустимый владелец'), { errorCode: 'invalid' }),
    );
    await expect(
      ctl.createContact({ first_name: 'И', last_name: 'И', assignee_id: 'ghost' }, md),
    ).rejects.toMatchObject({ errorCode: 'invalid' });
    expect(contacts.create).not.toHaveBeenCalled();
  });

  it('владелец = сам создатель (или пусто) — без похода в control', async () => {
    const { ctl, contacts, md, reassignTargets } = buildController();
    await ctl.createContact({ first_name: 'И', last_name: 'И' }, md);
    await ctl.createContact({ first_name: 'И', last_name: 'И', assignee_id: 'user-1' }, md);
    await ctl.createContact({ first_name: 'И', last_name: 'И', assignee_id: '   ' }, md);
    expect(reassignTargets.assertOwnerAssignable).not.toHaveBeenCalled();
    for (const call of contacts.create.mock.calls) expect(call[1].ownerId).toBe('user-1');
  });

  it('импорт владельца не выбирает — гейт не зовётся', async () => {
    const { ctl, md, reassignTargets } = buildController();
    await ctl.importContacts(
      { file_content: Buffer.from('Имя,Фамилия,Телефон\nИван,Иванов,+79001112233\n', 'utf8') },
      md,
    );
    expect(reassignTargets.assertOwnerAssignable).not.toHaveBeenCalled();
  });
});

describe('UpdateContact: очистка списков только по явному флагу', () => {
  it('без set_tags пустой список означает «не менять»', async () => {
    const { ctl, contacts, md } = buildController();
    await ctl.updateContact({ id: 'c1', tags: [] }, md);
    expect(contacts.update.mock.calls[0][2].tags).toBeUndefined();
  });

  it('set_tags=true с пустым списком очищает теги', async () => {
    const { ctl, contacts, md } = buildController();
    await ctl.updateContact({ id: 'c1', tags: [], set_tags: true }, md);
    expect(contacts.update.mock.calls[0][2].tags).toEqual([]);
  });

  it('set_company_ids=true применяет новый список компаний', async () => {
    const { ctl, contacts, md } = buildController();
    await ctl.updateContact({ id: 'c1', company_ids: ['co-9'], set_company_ids: true }, md);
    expect(contacts.update.mock.calls[0][2].companyIds).toEqual(['co-9']);
  });

  it('middle_name и notes доезжают до сервиса', async () => {
    const { ctl, contacts, md } = buildController();
    await ctl.updateContact({ id: 'c1', middle_name: 'П', notes: 'n' }, md);
    expect(contacts.update.mock.calls[0][2]).toMatchObject({ middleName: 'П', notes: 'n' });
  });
});

describe('GetContact: тени слияния доезжают до клиента (TODO-161)', () => {
  it('merged_sources отдаются в snake_case с числовыми метками времени', async () => {
    const mergedAt = 1_755_000_000_000;
    const { ctl, md } = buildController({
      findOne: jest.fn(async () => ({
        id: 'c1',
        mergedSources: [
          {
            id: 'src-1',
            firstName: 'Иван',
            lastName: 'Донор',
            middleName: 'П',
            email: 'src@x.ru',
            phone: '+79001112233',
            mergedAt,
            unmergeUntil: mergedAt + 30 * 24 * 60 * 60 * 1000,
          },
        ],
      })),
    });
    const res = (await ctl.getContact({ id: 'c1' }, md)) as unknown as {
      merged_sources: Record<string, unknown>[];
    };
    expect(res.merged_sources).toEqual([
      {
        id: 'src-1',
        first_name: 'Иван',
        last_name: 'Донор',
        middle_name: 'П',
        email: 'src@x.ru',
        phone: '+79001112233',
        merged_at: mergedAt,
        unmerge_until: mergedAt + 30 * 24 * 60 * 60 * 1000,
      },
    ]);
  });

  it('контакт без слияний отдаёт пустой список, а не undefined (proto repeated)', async () => {
    const { ctl, md } = buildController();
    const res = (await ctl.getContact({ id: 'c1' }, md)) as unknown as {
      merged_sources: unknown[];
    };
    expect(res.merged_sources).toEqual([]);
  });
});

describe('ImportContacts: карта колонок и отчёт по пропущенным строкам', () => {
  it('карта колонок из мастера применяется к файлу', async () => {
    const { ctl, contacts, md } = buildController();
    const file = Buffer.from('Колонка A;Колонка B;Колонка C\nИванов;Иван;a@b.ru', 'utf8');
    const res = (await ctl.importContacts(
      {
        file_content: file,
        mapping_json: '{"0":"lastName","1":"firstName","2":"email"}',
      },
      md,
    )) as { created: number };
    expect(res.created).toBe(1);
    expect(contacts.create.mock.calls[0][1]).toMatchObject({
      lastName: 'Иванов',
      firstName: 'Иван',
      email: 'a@b.ru',
    });
  });

  it('дубль отдаётся строкой отчёта с причиной и совпавшей записью', async () => {
    const { ctl, md } = buildController({
      findDuplicates: jest.fn(async () => ({
        candidates: [
          { contactId: 'c-existing', displayName: 'И', matchedOn: 'email', maskedValue: 'a***' },
        ],
        possibleExternalDuplicate: false,
      })),
    });
    const file = Buffer.from('Имя;Фамилия;Телефон;Email\nИван;Иванов;;a@b.ru', 'utf8');
    const res = (await ctl.importContacts({ file_content: file }, md)) as {
      created: number;
      updated: number;
      skipped: number;
      skipped_rows: Record<string, unknown>[];
    };
    expect(res.created).toBe(0);
    expect(res.updated).toBe(0);
    expect(res.skipped).toBe(1);
    expect(res.skipped_rows).toEqual([
      { row: 2, reason: 'duplicate', matched_contact_id: 'c-existing', matched_field: 'email' },
    ]);
  });

  it('строка без имени — reason missing_name, номер строки как в файле', async () => {
    const { ctl, md } = buildController();
    const file = Buffer.from('Имя;Фамилия;Телефон;Email\n;;+79001112233;a@b.ru', 'utf8');
    const res = (await ctl.importContacts({ file_content: file }, md)) as {
      skipped_rows: Record<string, unknown>[];
    };
    expect(res.skipped_rows[0]).toMatchObject({ row: 2, reason: 'missing_name' });
  });

  it('отказ домена по строке (нет канала связи) — reason invalid, импорт не падает', async () => {
    const { ctl, md } = buildController({
      create: jest.fn(async () => {
        throw Object.assign(new Error('Укажите телефон или e-mail контакта'), {
          errorCode: 'invalid',
        });
      }),
    });
    const file = Buffer.from('Имя;Фамилия\nИван;Иванов', 'utf8');
    const res = (await ctl.importContacts({ file_content: file }, md)) as {
      created: number;
      skipped: number;
      skipped_rows: Record<string, unknown>[];
      errors: string[];
    };
    expect(res.created).toBe(0);
    expect(res.skipped).toBe(1);
    expect(res.skipped_rows[0]).toMatchObject({ row: 2, reason: 'invalid' });
    expect(res.errors[0]).toContain('Строка 2');
  });

  it('регрессия TODO-164: кавычки с запятой внутри не сдвигают колонки импорта', async () => {
    const { ctl, contacts, md } = buildController();
    const file = Buffer.from(
      'Имя;Фамилия;Телефон;Email\n"Иванов, Иван";Иванов;+79001234567;a@b.ru',
      'utf8',
    );
    await ctl.importContacts({ file_content: file }, md);
    expect(contacts.create.mock.calls[0][1]).toMatchObject({
      firstName: 'Иванов, Иван',
      phone: '+79001234567',
      email: 'a@b.ru',
    });
  });
});
