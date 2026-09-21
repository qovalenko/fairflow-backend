/**
 * [be-gw-contacts-import] FR-CONTACTS-360/371 — импорт контактов на шлюзе.
 *
 * Мастер импорта шлёт multipart из трёх частей (file + filename + mapping), а
 * хендлер читал только `req.file()`: карта колонок и имя файла до домена не
 * доезжали вовсе — экран разметки колонок был декоративным. Плюс ответ домена
 * отдавался клиенту сырым (snake_case), а мастер ждёт camelCase и построчные
 * пропуски.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { of } from 'rxjs';
import { BadRequestException } from '@nestjs/common';
import type { ClientGrpcProxy } from '@nestjs/microservices';
import { CrmBffController } from './crm-bff.controller';
import { IMPORT_MAPPABLE_CONTACT_FIELDS } from './import-mapping';

/**
 * Доменный allowlist читаем из ИСХОДНИКА домена, а не из копии-литерала: сверка с
 * копией ловит только правку шлюза, а разъезд начинается с любой из сторон.
 * Импортировать модуль домена в тест шлюза нельзя — это чужой workspace.
 */
function domainImportableContactFields(): string[] {
  const src = readFileSync(
    join(__dirname, '../../../contact/src/contacts/import-mapping.ts'),
    'utf8',
  );
  const marker = 'export const IMPORTABLE_CONTACT_FIELDS = new Set([';
  const start = src.indexOf(marker);
  if (start < 0) throw new Error('в домене не найден IMPORTABLE_CONTACT_FIELDS');
  const body = src.slice(start + marker.length, src.indexOf(']', start));
  return [...body.matchAll(/'([^']+)'/g)].map((m) => m[1]);
}

function stubClient(service: Record<string, unknown> = {}): ClientGrpcProxy {
  return { getService: () => service } as unknown as ClientGrpcProxy;
}

function build(contactService: Record<string, unknown>) {
  const outboundMeta = { build: () => ({}) } as never;
  const ctrl = new CrmBffController(
    stubClient(), // pipe
    stubClient(), // orders
    stubClient(), // product
    stubClient(), // activity
    stubClient(), // documents
    stubClient(), // reports
    stubClient(), // automation
    stubClient(), // control
    stubClient(contactService), // contact (9th)
    stubClient(), // company
    outboundMeta,
    {} as never,
    { s3DocumentsBucket: 'fairflow-documents' } as never, // config (X4)
    { resolveNames: async () => new Map() } as never, // identity (TODO-207)
    {} as never, // reportRunNames
  );
  ctrl.onModuleInit();
  return ctrl;
}

function multipartReq(opts: {
  file?: { buffer: Buffer; filename?: string } | null;
  fields?: Record<string, string>;
}) {
  const parts: unknown[] = [];
  if (opts.file !== null) {
    const f = opts.file ?? { buffer: Buffer.from('a,b\n1,2', 'utf8'), filename: 'contacts.csv' };
    parts.push({
      type: 'file',
      fieldname: 'file',
      filename: f.filename ?? 'contacts.csv',
      mimetype: 'text/csv',
      toBuffer: async () => f.buffer,
      file: { truncated: false },
    });
  }
  for (const [fieldname, value] of Object.entries(opts.fields ?? {})) {
    parts.push({ type: 'field', fieldname, value });
  }
  return {
    headers: {},
    query: {},
    user: { userId: 'u1' },
    isMultipart: () => true,
    parts: async function* () {
      for (const p of parts) yield p;
    },
  } as never;
}

const OK = { created: 1, skipped: 0, errors: [], updated: 0, skipped_rows: [] };

describe('[be-gw-contacts-import] карта колонок доезжает до домена', () => {
  it('передаёт mapping_json (развёрнутый в ориентацию домена) и filename', async () => {
    const importContacts = jest.fn((_p: Record<string, unknown>, _m?: unknown) => of(OK));
    const ctrl = build({ importContacts });

    await ctrl.importContacts(
      multipartReq({
        file: { buffer: Buffer.from('email,Имя\na@b.c,Иван', 'utf8'), filename: 'my.csv' },
        fields: {
          filename: 'my.csv',
          mapping: JSON.stringify({ email: '0', firstName: '1', position: '' }),
        },
      }),
      'p1',
    );

    const payload = importContacts.mock.calls[0][0] as Record<string, unknown>;
    expect(JSON.parse(String(payload.mapping_json))).toEqual({ '0': 'email', '1': 'firstName' });
    expect(payload.filename).toBe('my.csv');
    expect(Buffer.isBuffer(payload.file_content)).toBe(true);
    expect(payload.project_id).toBe('p1');
  });

  it('принимает уже правильную ориентацию карты («индекс → поле»)', async () => {
    const importContacts = jest.fn((_p: Record<string, unknown>, _m?: unknown) => of(OK));
    const ctrl = build({ importContacts });

    await ctrl.importContacts(
      multipartReq({ fields: { mapping: JSON.stringify({ '0': 'lastName', '1': 'phone' }) } }),
      'p1',
    );

    const payload = importContacts.mock.calls[0][0] as Record<string, unknown>;
    expect(JSON.parse(String(payload.mapping_json))).toEqual({ '0': 'lastName', '1': 'phone' });
  });

  it.each(['ownerId', 'assigneeId', 'createdBy', 'departmentId', 'projectId', 'id'])(
    'отбивает 400 на попытку замапить служебное поле %s (подделка атрибуции/ABAC)',
    async (field) => {
      const importContacts = jest.fn((_p: Record<string, unknown>, _m?: unknown) => of(OK));
      const ctrl = build({ importContacts });

      await expect(
        ctrl.importContacts(
          multipartReq({ fields: { mapping: JSON.stringify({ firstName: '0', [field]: '1' }) } }),
          'p1',
        ),
      ).rejects.toThrow(/нельзя заполнять из файла импорта/);
      expect(importContacts).not.toHaveBeenCalled();
    },
  );

  it('allowlist шлюза совпадает с доменным — поле-приманка не доезжает до домена', () => {
    // Домен (`contact/src/contacts/import-mapping.ts`, IMPORTABLE_CONTACT_FIELDS)
    // проверяет карту последним и на неизвестном поле роняет ВЕСЬ файл. Поле,
    // разрешённое только на шлюзе (так было с `companyName`), мастер предлагает
    // замапить — и пользователь получает 400 на честной разметке.
    const domain = domainImportableContactFields();
    expect(domain.length).toBeGreaterThan(0);
    expect([...IMPORT_MAPPABLE_CONTACT_FIELDS].sort()).toEqual([...domain].sort());
  });

  it.each(['ownerId', 'assigneeId', 'createdBy', 'departmentId', 'projectId', 'id', 'companyName'])(
    'ни один allowlist (шлюз/домен) не содержит %s',
    (field) => {
      // Служебные поля — подделка атрибуции/ABAC; `companyName` — поле, которого у
      // контакта нет (связь с компанией это `companyIds`), домен его не запишет.
      expect(IMPORT_MAPPABLE_CONTACT_FIELDS.has(field)).toBe(false);
      expect(domainImportableContactFields()).not.toContain(field);
    },
  );

  it('отбивает 400 на companyName: у контакта нет такого поля (связь — companyIds)', async () => {
    const importContacts = jest.fn((_p: Record<string, unknown>, _m?: unknown) => of(OK));
    const ctrl = build({ importContacts });

    await expect(
      ctrl.importContacts(
        multipartReq({ fields: { mapping: JSON.stringify({ firstName: '0', companyName: '1' }) } }),
        'p1',
      ),
    ).rejects.toThrow(/нельзя заполнять из файла импорта/);
    expect(importContacts).not.toHaveBeenCalled();
  });

  it('без файла — чистый 400, а не пустой импорт', async () => {
    const importContacts = jest.fn((_p: Record<string, unknown>, _m?: unknown) => of(OK));
    const ctrl = build({ importContacts });

    await expect(ctrl.importContacts(multipartReq({ file: null }), 'p1')).rejects.toThrow(
      BadRequestException,
    );
    expect(importContacts).not.toHaveBeenCalled();
  });
});

describe('[be-gw-contacts-import] ответ домена → контракт мастера импорта', () => {
  it('домапливает updated и построчные пропуски в camelCase', async () => {
    const ctrl = build({
      importContacts: jest.fn(() =>
        of({
          created: 2,
          updated: 3,
          skipped: 1,
          errors: ['Row 5: missing name'],
          skipped_rows: [
            { row: 4, reason: 'duplicate', matched_contact_id: 'c9', matched_field: 'email' },
          ],
        }),
      ),
    });

    const res = (await ctrl.importContacts(multipartReq({}), 'p1')) as {
      created: number;
      updated: number;
      skipped: { row: number; reason: string; matchedContactId: string; matchedField: string }[];
      errors: string[];
    };

    expect(res.created).toBe(2);
    expect(res.updated).toBe(3);
    expect(res.skipped).toEqual([
      { row: 4, reason: 'duplicate', matchedContactId: 'c9', matchedField: 'email' },
    ]);
    expect(res.errors).toHaveLength(1);
  });

  it('пока домен не заполняет skipped_rows — отдаёт счётчик, а не пустой массив', async () => {
    const ctrl = build({
      importContacts: jest.fn((_p: Record<string, unknown>, _m?: unknown) =>
        of({ created: 1, skipped: 7, errors: [], skipped_rows: [] }),
      ),
    });

    const res = (await ctrl.importContacts(multipartReq({}), 'p1')) as {
      skipped: number;
      updated: number;
    };
    // Пустой массив показал бы пользователю «Пропущено 0» при семи пропущенных строках.
    expect(res.skipped).toBe(7);
    expect(res.updated).toBe(0);
  });
});
