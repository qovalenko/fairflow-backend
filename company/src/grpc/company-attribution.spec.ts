/**
 * TODO-364 / FR-COMPANIES-210: атрибуция компании (кто создал, кто изменил,
 * откуда запись) обязана доезжать до карточки.
 *
 * Регресс, который пинуется, — «домен умеет, а до пользователя не доходит»:
 * `CompanyDoc` хранит `createdBy`/`updatedBy`/`source` (mongo.service.ts) и
 * `toResponse` их отдаёт, но proto-контракт этих полей не содержал, а `toProto`
 * их не проецировал. Gateway при этом домапливал `created_by`/`updated_by`/
 * `source` (v1-data-bff.controller.ts, mapCompany) — то есть читатель у полей
 * был, а производителя не было, и блок «Создал / Изменил» в CompanyDetails
 * оставался пустым при любых правах.
 *
 * Здесь проверяется именно ПРОИЗВОДИТЕЛЬ (gRPC-проекция домена); симметричный
 * тест на домап gateway живёт в gateway/src/bff/v1-data-bff.companies.spec.ts.
 */
import { CompanyGrpcController } from './company.grpc.controller';
import type { CompaniesService } from '../companies/companies.service';
import type { IdempotencyService } from '../idempotency/idempotency.service';
import { ReassignTargetValidator } from '../companies/reassign-target.validator';

function build(row: Record<string, unknown>) {
  const companies = { findOne: jest.fn(async () => row) } as unknown as CompaniesService;
  return new CompanyGrpcController(
    companies,
    {} as IdempotencyService,
    new ReassignTargetValidator(),
  );
}

describe('[be-company] TODO-364: атрибуция в gRPC-проекции компании', () => {
  it('GetCompany отдаёт created_by/updated_by/source', async () => {
    const ctrl = build({
      id: 'co1',
      projectId: 'p1',
      name: 'Акме',
      createdAt: 1_700_000_000_000,
      updatedAt: 1_700_000_100_000,
      createdBy: 'u7',
      updatedBy: 'u8',
      source: 'import',
    });

    const res = (await ctrl.get({ project_id: 'p1', id: 'co1' })) as Record<string, unknown>;

    expect(res.created_by).toBe('u7');
    expect(res.updated_by).toBe('u8');
    expect(res.source).toBe('import');
  });

  it('запись без атрибуции даёт пустые строки, а не undefined (proto3-дефолт)', async () => {
    const ctrl = build({
      id: 'co2',
      projectId: 'p1',
      name: 'Без автора',
      createdAt: 1,
      updatedAt: 2,
    });

    const res = (await ctrl.get({ project_id: 'p1', id: 'co2' })) as Record<string, unknown>;

    expect(res.created_by).toBe('');
    expect(res.updated_by).toBe('');
    expect(res.source).toBe('');
  });
});
