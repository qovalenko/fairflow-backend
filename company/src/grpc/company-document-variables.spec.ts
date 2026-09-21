/**
 * TODO-073 (company-половина): ABAC-предикат обязан применяться на ВСЕХ путях,
 * а не только на «обычных» чтениях/мутациях.
 *
 * Дыра, которую закрывает этот тест: `ResolveDocumentVariables` — донор
 * переменных для домена documents — читал компанию только по
 * `readVisibilityScope(metadata)`, без `readAccessPredicate(metadata)`.
 * То есть шаблон документа отдавал реквизиты компании в обход ABAC-предиката,
 * а при malformed-предикате (сломанное deny-правило) не срабатывал fail-closed.
 *
 * Проверяется ПЕРЕДАЧА предиката контроллером (клиент → домен): сервисный гейт
 * (`findOne` + `scopedFilter`/`evalGate`) уже покрыт в
 * companies/company.abac.spec.ts, здесь — что донор до него доносит предикат.
 */
import { Metadata } from '@grpc/grpc-js';
import { compileMongoRaw, normalizeAbac, type AbacNode } from '@fairflow/shared';
import { CompanyGrpcController } from './company.grpc.controller';
import type { CompaniesService } from '../companies/companies.service';
import type { IdempotencyService } from '../idempotency/idempotency.service';
import { ReassignTargetValidator } from '../companies/reassign-target.validator';

const REGION_EQ: AbacNode = { op: 'eq', left: { ref: 'record.region' }, right: { lit: 'msk' } };

function md(predicateHeader?: string): Metadata {
  const m = new Metadata();
  m.set('x-project-id', 'p1');
  if (predicateHeader !== undefined) m.set('x-access-predicate', predicateHeader);
  return m;
}

function encodePredicate(ir: AbacNode): string {
  const normalized = normalizeAbac(ir);
  return Buffer.from(
    JSON.stringify({ mongo: compileMongoRaw(normalized), ir: normalized }),
    'utf8',
  ).toString('base64');
}

function build() {
  const resolveDocumentVariables: jest.Mock<
    Promise<{ values: Record<string, string>; source_hash: string; empty_required: string[] }>,
    [string, string, unknown?, unknown?]
  > = jest.fn(
    async (_projectId: string, _recordId: string, _scope?: unknown, _access?: unknown) => ({
      values: { 'company.name': 'Акме' },
      source_hash: 'h',
      empty_required: [],
    }),
  );
  const companies = { resolveDocumentVariables } as unknown as CompaniesService;
  return {
    ctrl: new CompanyGrpcController(
      companies,
      {} as IdempotencyService,
      new ReassignTargetValidator(),
    ),
    resolveDocumentVariables,
  };
}

describe('[be-company] TODO-073: ResolveDocumentVariables применяет ABAC-предикат', () => {
  it('прокидывает разобранный предикат в сервис (present + mongo + ir)', async () => {
    const { ctrl, resolveDocumentVariables } = build();

    await ctrl.resolveDocumentVariables({ record_id: 'co1' }, md(encodePredicate(REGION_EQ)));

    expect(resolveDocumentVariables).toHaveBeenCalledTimes(1);
    const access = resolveDocumentVariables.mock.calls[0][3] as Record<string, unknown>;
    expect(access).toBeDefined();
    expect(access.present).toBe(true);
    expect(access.malformed).toBeFalsy();
    expect(access.mongo).toEqual({ region: { $eq: 'msk' } });
    expect(access.ir).toBeTruthy();
  });

  it('malformed-заголовок доезжает как fail-closed предикат, а не как «предиката нет»', async () => {
    const { ctrl, resolveDocumentVariables } = build();

    await ctrl.resolveDocumentVariables({ record_id: 'co1' }, md('%%not-base64-json%%'));

    const access = resolveDocumentVariables.mock.calls[0][3] as Record<string, unknown>;
    expect(access).toMatchObject({ present: true, malformed: true });
  });

  it('без заголовка предикат отсутствует (никакого фиктивного ALL-scope)', async () => {
    const { ctrl, resolveDocumentVariables } = build();

    await ctrl.resolveDocumentVariables({ record_id: 'co1' }, md());

    const access = resolveDocumentVariables.mock.calls[0][3] as Record<string, unknown>;
    expect(access).toEqual({ present: false });
  });
});
