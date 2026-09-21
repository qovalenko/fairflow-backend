/**
 * [be-gw-import-allowlist] Карта колонок импорта компаний — allowlist целевых полей.
 *
 * Домен пишет размеченные колонки в документ как есть, а `createdBy`/`departmentId`/
 * `ownerId` не перетираются сервером (в отличие от `source` и `status`). Значит без
 * allowlist карта вида `{"createdBy":"0"}` подделывает атрибуцию аудита, а
 * `{"departmentId":"1"}` — привязку к отделу, участвующую в ABAC-фильтрации.
 * Проверяем, что шлюз отбивает такую карту 400 и до домена она не доезжает.
 */
import { of } from 'rxjs';
import type { ClientGrpcProxy } from '@nestjs/microservices';
import { V1DataBffController } from './v1-data-bff.controller';

function stubClient(service: Record<string, unknown> = {}): ClientGrpcProxy {
  return { getService: () => service } as unknown as ClientGrpcProxy;
}

function build(company: Record<string, unknown>) {
  const outboundMeta = { build: () => ({}) } as never;
  const ctrl = new V1DataBffController(
    stubClient(),
    stubClient(),
    stubClient(company),
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

describe('[be-gw-import-allowlist] companies import column mapping', () => {
  const FORBIDDEN = ['createdBy', 'departmentId', 'ownerId', 'source', 'status', 'projectId'];

  it.each(FORBIDDEN)('rejects a mapping targeting %s (wizard orientation)', async (field) => {
    const importCompanies = jest.fn(() => of({ created: 0, skipped: 0, errors: [] }));
    const ctrl = build({ importCompanies });

    await expect(
      ctrl.importCompanies(req, 'p1', {
        fileContent: 'name,x\nАкме,0',
        mappingJson: JSON.stringify({ name: '0', [field]: '1' }),
      }),
    ).rejects.toThrow(/нельзя заполнять из файла импорта/);
    expect(importCompanies).not.toHaveBeenCalled();
  });

  it.each(FORBIDDEN)('rejects a mapping targeting %s (domain orientation)', async (field) => {
    const importCompanies = jest.fn(() => of({ created: 0, skipped: 0, errors: [] }));
    const ctrl = build({ importCompanies });

    await expect(
      ctrl.importCompanies(req, 'p1', {
        fileContent: 'name,x\nАкме,0',
        mappingJson: JSON.stringify({ '0': 'name', '1': field }),
      }),
    ).rejects.toThrow(/нельзя заполнять из файла импорта/);
    expect(importCompanies).not.toHaveBeenCalled();
  });

  it('passes a mapping made of business fields only (and normalizes orientation)', async () => {
    const importCompanies = jest.fn((_p: Record<string, unknown>, _m?: unknown) =>
      of({ created: 1, updated: 0, skipped: 0, errors: [] }),
    );
    const ctrl = build({ importCompanies });

    await ctrl.importCompanies(req, 'p1', {
      fileContent: 'name,inn,email\nАкме,7701,a@b.c',
      mappingJson: JSON.stringify({ name: '0', inn: '1', email: '2', notes: '' }),
    });

    const payload = importCompanies.mock.calls[0][0] as Record<string, unknown>;
    expect(JSON.parse(String(payload.mapping_json))).toEqual({
      '0': 'name',
      '1': 'inn',
      '2': 'email',
    });
  });
});
